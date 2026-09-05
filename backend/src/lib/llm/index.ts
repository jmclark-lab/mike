import { streamSakana, completeSakanaText } from "./sakana";
import { streamClaude, completeClaudeText } from "./claude";
import { completeGeminiText } from "./gemini";
import { completeOpenAIText } from "./openai";
import { completeXaiText, streamXai } from "./xai";
import { completeDeepSeekText, streamDeepSeek } from "./deepseek";
import { providerForModel } from "./models";
import type {
    ProviderMetadata,
    ReasoningEffort,
    SkippedModel,
    StreamChatParams,
    StreamChatResult,
    UserApiKeys,
} from "./types";
import { isGroundingEnabled, buildGroundingContext } from "../hybridSearch";

export * from "./types";
export * from "./models";

const DEFAULT_FABLE_MODEL = "claude-fable-5-1";
// Stable Anthropic fallback after Fable 5.1 (highest-intelligence policy).
const INTERIM_STABLE_MODEL = "claude-opus-5";
// Final tail fallback: OpenAI GPT-6 Astra. Only reached if Fable and Opus
// both fail. Requires the OpenAI account to have billing/quota; until funded
// it returns insufficient_quota (429) and the chain simply ends here.
const FINAL_OPENAI_FALLBACK = "gpt-6-astra";

/**
 * Chat primary. `LLM_MODEL` is the only env var that can change this.
 * `SAKANA_MODEL` and `LLM_PROVIDER` must never promote a Sakana model into
 * the primary slot as a side effect — they previously did when `LLM_MODEL`
 * was unset, which is why production `/healthz` showed Fugu first.
 */
export function resolveActiveModel(): string {
    const explicit = process.env.LLM_MODEL?.trim();
    if (explicit) return explicit;
    return DEFAULT_FABLE_MODEL;
}

/**
 * Ordered model fallback chain. Default is a three-way chain with no Sakana hop:
 *   1. Fable 5.1    (primary)    — claude-fable-5-1
 *   2. Opus 5       (fallback)   — claude-opus-5
 *   3. GPT-6 Astra  (final net)  — gpt-6-astra
 *
 * `LLM_MODEL` replaces the primary. `LLM_FALLBACK_MODEL` replaces the tail
 * (comma-separated model ids, tried in the order given). To put Fugu back in
 * the chain, name it explicitly in one of those two variables.
 * `SAKANA_MODEL` only selects which Fugu variant is used when a Sakana model
 * is actually invoked — it never composes this chain.
 */
export function resolveModelChain(): string[] {
    const chain: string[] = [];
    const push = (m?: string | null) => {
        const v = m?.trim();
        if (v && !chain.includes(v)) chain.push(v);
    };

    push(resolveActiveModel());

    const explicitFallbacks = process.env.LLM_FALLBACK_MODEL?.trim();
    if (explicitFallbacks) {
        for (const m of explicitFallbacks.split(",")) push(m);
    } else {
        push(INTERIM_STABLE_MODEL);
        push(FINAL_OPENAI_FALLBACK);
    }

    return chain;
}

export function persistableProviderMetadata(
    meta?: ProviderMetadata | null,
): ProviderMetadata {
    if (!meta?.provider_name || !meta.model_name) {
        return { provider_name: "unknown", model_name: "unknown" };
    }
    const out: ProviderMetadata = {
        provider_name: meta.provider_name,
        model_name: meta.model_name,
    };
    if (meta.provider_response_id) out.provider_response_id = meta.provider_response_id;
    if (typeof meta.fallback_depth === "number") out.fallback_depth = meta.fallback_depth;
    if (meta.attempted_models) out.attempted_models = meta.attempted_models;
    if (meta.skipped_models) out.skipped_models = meta.skipped_models;
    return out;
}

function telemetryProviderName(model: string): string {
    try {
        const provider = providerForModel(model);
        return provider === "sakana" ? "sakana_fugu" : provider;
    } catch {
        return "unknown";
    }
}

function skippedHop(model: string, err: unknown): SkippedModel {
    const reason = err instanceof Error ? err.message : String(err);
    return {
        provider_name: telemetryProviderName(model),
        model_name: model,
        failure_class: classifyLlmError(err),
        failure_reason: reason.slice(0, 500),
    };
}

export function attachRoutingTrail(
    meta: ProviderMetadata | undefined,
    model: string,
    fallbackDepth: number,
    attempted: string[],
    skipped: SkippedModel[],
): ProviderMetadata {
    return {
        provider_name: meta?.provider_name || telemetryProviderName(model),
        model_name: meta?.model_name || model,
        ...(meta?.provider_response_id
            ? { provider_response_id: meta.provider_response_id }
            : {}),
        fallback_depth: fallbackDepth,
        attempted_models: attempted,
        skipped_models: skipped,
    };
}

function isEmptyResult(text: string | null | undefined): boolean {
    return !text || text.trim().length === 0;
}

// Structured per-call telemetry: one JSON line per LLM call, greppable in Railway
// logs and shippable to Axiom/Better Stack via a log drain. fallback_depth > 0 is
// the leading indicator of a provider problem.
function classifyLlmError(err: unknown): string {
    const msg = String(err instanceof Error ? err.message : err).toLowerCase();
    if (msg.includes("empty")) return "empty_response";
    if (msg.includes("abort")) return "aborted";
    if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many")) return "rate_limited";
    if (msg.includes("timeout") || msg.includes("timed out")) return "timeout";
    if (msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("522") || msg.includes("524") || msg.includes("service")) return "upstream_unavailable";
    if (msg.includes("network") || msg.includes("fetch failed") || msg.includes("econn")) return "network";
    return "other";
}

function logLlmCall(payload: Record<string, unknown>): void {
    try {
        console.log("[llm.telemetry] " + JSON.stringify({ event: "llm_call", ...payload }));
    } catch {
        /* never let logging break a request */
    }
}

function isRetryableError(err: unknown): boolean {
    const msg = String(err instanceof Error ? err.message : err).toLowerCase();
    return (
        msg.includes("not_found") ||
        msg.includes("overloaded") ||
        msg.includes("timeout") ||
        msg.includes("timed out") ||
        msg.includes("aborted") ||
        msg.includes("abort") ||
        msg.includes("empty response") ||
        msg.includes("empty") ||
        msg.includes("429") ||
        msg.includes("rate limit") ||
        msg.includes("too many requests") ||
        msg.includes("socket hang up") ||
        msg.includes("fetch failed") ||
        msg.includes("network") ||
        msg.includes("eai_again") ||
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("econnaborted") ||
        msg.includes("524") ||
        msg.includes("503") ||
        msg.includes("502") ||
        msg.includes("service_unavailable") ||
        msg.includes("service unavailable")
    );
}

// ---------------------------------------------------------------------------
// Health-aware routing: when a model returns empty or a retryable error, put it
// on a short cooldown so subsequent requests try the healthy models first
// (avoids repeatedly paying the latency of a known-bad primary). In-memory and
// per-process; self-heals after MODEL_COOLDOWN_MS. A cooling-down model is only
// deprioritised, never removed -- it is still tried last if every other model
// is also unhealthy.
// Cooldown with exponential backoff + jitter. Base 60s, doubling per consecutive
// failure, capped at 15 min; resets on success. When a cooldown expires the next
// request naturally re-probes the model (half-open) and either resets it or
// escalates the backoff. In-memory/per-process: resets on deploy/restart and is
// not shared across instances -- externalize to Postgres/Redis if that matters.
const MODEL_COOLDOWN_BASE_MS = 60 * 1000;
const MODEL_COOLDOWN_MAX_MS = 15 * 60 * 1000;
const modelCooldownUntil = new Map<string, number>();
const modelFailureStreak = new Map<string, number>();

function markModelUnhealthy(model: string): void {
    const streak = (modelFailureStreak.get(model) ?? 0) + 1;
    modelFailureStreak.set(model, streak);
    const backoff = Math.min(
        MODEL_COOLDOWN_BASE_MS * 2 ** (streak - 1),
        MODEL_COOLDOWN_MAX_MS,
    );
    const jitter = Math.floor(Math.random() * backoff * 0.2); // up to +20%
    modelCooldownUntil.set(model, Date.now() + backoff + jitter);
}

function markModelHealthy(model: string): void {
    modelCooldownUntil.delete(model);
    modelFailureStreak.delete(model);
}

function isModelCoolingDown(model: string): boolean {
    const until = modelCooldownUntil.get(model);
    if (until === undefined) return false;
    if (Date.now() >= until) {
        modelCooldownUntil.delete(model);
        return false;
    }
    return true;
}

// Stable-partition the chain: healthy models keep their configured priority;
// cooling-down models move to the back. If every model is cooling down, keep
// the original order so we still attempt them.
function orderByHealth(chain: string[]): string[] {
    const healthy = chain.filter((m) => !isModelCoolingDown(m));
    if (healthy.length === 0) return chain;
    const cooling = chain.filter((m) => isModelCoolingDown(m));
    return [...healthy, ...cooling];
}

// Snapshot of the routing/cooldown state for /healthz and telemetry.
export function getRoutingHealth(): {
    chain: string[];
    coolingDown: { model: string; ms_remaining: number; failures: number }[];
} {
    const now = Date.now();
    const coolingDown = [...modelCooldownUntil.entries()]
        .filter(([, until]) => until > now)
        .map(([model, until]) => ({
            model,
            ms_remaining: until - now,
            failures: modelFailureStreak.get(model) ?? 0,
        }));
    return { chain: resolveModelChain(), coolingDown };
}

async function invokeStream(
    model: string,
    params: StreamChatParams & { systemPrompt?: string },
): Promise<StreamChatResult> {
    const provider = providerForModel(model);
    if (provider === "claude") return streamClaude({ ...params, model });
    if (provider === "xai") return streamXai({ ...params, model });
    if (provider === "deepseek") return streamDeepSeek({ ...params, model });
    return streamSakana({ ...params, model });
}

async function invokeComplete(
    model: string,
    params: {
        systemPrompt?: string;
        user: string;
        maxTokens?: number;
        apiKeys?: UserApiKeys;
        reasoningEffort?: ReasoningEffort;
    },
): Promise<string> {
    const provider = providerForModel(model);
    if (provider === "claude") return completeClaudeText({ ...params, model });
    if (provider === "gemini") return completeGeminiText({ ...params, model });
    if (provider === "openai") return completeOpenAIText({ ...params, model });
    if (provider === "xai") return completeXaiText({ ...params, model });
    if (provider === "deepseek") return completeDeepSeekText({ ...params, model });
    return completeSakanaText({ ...params, model });
}

export async function streamChatWithTools(params: StreamChatParams): Promise<StreamChatResult> {
    let { systemPrompt } = params;
    if (isGroundingEnabled()) {
        const lastUserMsg = [...(params.messages ?? [])].reverse().find(m => m.role === "user");
        const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg?.content ?? "");
        if (userText) {
            try {
                const contextBlock = await buildGroundingContext(userText);
                if (contextBlock) {
                    systemPrompt = `${contextBlock}\n\n${systemPrompt ?? ""}`;
                }
            } catch (err) {
                console.warn("[search-router] grounding injection failed, proceeding without web context:", err);
            }
        }
    }

    // Streaming chat always uses the configured env chain. `params.model`
    // (the UI-selected model) is intentionally not applied here — flagged,
    // not changed: see streamChatWithTools call sites in chatTools.ts.
    const chain = orderByHealth(resolveModelChain());
    console.log(`[llm] model fallback chain: ${chain.join(" -> ")}`);

    const startedAt = Date.now();
    const skipped: SkippedModel[] = [];
    let lastError: unknown;
    for (let i = 0; i < chain.length; i++) {
        const model = chain[i];
        const isLast = i === chain.length - 1;
        try {
            const result = await invokeStream(model, { ...params, systemPrompt });
            if (isEmptyResult(result.fullText)) {
                markModelUnhealthy(model);
                if (!isLast) {
                    lastError = new Error(`empty response from ${model}`);
                    skipped.push(skippedHop(model, lastError));
                    console.warn(`[llm] ${model} returned an empty response; falling back to ${chain[i + 1]}`);
                    continue;
                }
            } else {
                markModelHealthy(model);
            }
            if (i > 0) console.log(`[llm] answered via fallback model ${model}`);
            const attempted = chain.slice(0, i + 1);
            result.providerMetadata = attachRoutingTrail(
                result.providerMetadata,
                model,
                i,
                attempted,
                skipped,
            );
            logLlmCall({
                surface: "stream",
                ok: true,
                answered: model,
                fallback_depth: i,
                attempted,
                skipped,
                empty: isEmptyResult(result.fullText),
                latency_ms: Date.now() - startedAt,
            });
            return result;
        } catch (err) {
            lastError = err;
            skipped.push(skippedHop(model, err));
            if (!isLast && isRetryableError(err)) {
                markModelUnhealthy(model);
                console.warn(`[llm] ${model} failed (${err instanceof Error ? err.message : String(err)}); falling back to ${chain[i + 1]}`);
                continue;
            }
            logLlmCall({
                surface: "stream",
                ok: false,
                failed_model: model,
                fallback_depth: i,
                attempted: chain.slice(0, i + 1),
                skipped,
                error_class: classifyLlmError(err),
                latency_ms: Date.now() - startedAt,
            });
            throw err;
        }
    }
    logLlmCall({
        surface: "stream",
        ok: false,
        error_class: "chain_exhausted",
        attempted: chain,
        skipped,
        latency_ms: Date.now() - startedAt,
    });
    throw lastError instanceof Error ? lastError : new Error("all models in the fallback chain failed");
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    // Honor the caller's requested model (e.g. a cheap low-tier title model) as
    // the primary, with the standard fallback chain behind it. Previously the
    // passed model was ignored and every completion ran the frontier chain.
    const requested = params.model?.trim();
    const fallbackChain = orderByHealth(resolveModelChain());
    const chain = requested
        ? [requested, ...fallbackChain.filter((m) => m !== requested)]
        : fallbackChain;

    const startedAt = Date.now();
    const skipped: SkippedModel[] = [];
    let lastError: unknown;
    for (let i = 0; i < chain.length; i++) {
        const model = chain[i];
        const isLast = i === chain.length - 1;
        try {
            const result = await invokeComplete(model, params);
            if (isEmptyResult(result)) {
                markModelUnhealthy(model);
                if (!isLast) {
                    lastError = new Error(`empty response from ${model}`);
                    skipped.push(skippedHop(model, lastError));
                    console.warn(`[llm] ${model} returned an empty completion; falling back to ${chain[i + 1]}`);
                    continue;
                }
            } else {
                markModelHealthy(model);
            }
            if (i > 0) console.log(`[llm] completeText answered via fallback model ${model}`);
            logLlmCall({
                surface: "complete",
                ok: true,
                answered: model,
                fallback_depth: i,
                attempted: chain.slice(0, i + 1),
                skipped,
                empty: isEmptyResult(result),
                latency_ms: Date.now() - startedAt,
            });
            return result;
        } catch (err) {
            lastError = err;
            skipped.push(skippedHop(model, err));
            if (!isLast && isRetryableError(err)) {
                markModelUnhealthy(model);
                console.warn(`[llm] ${model} failed in completeText (${err instanceof Error ? err.message : String(err)}); falling back to ${chain[i + 1]}`);
                continue;
            }
            logLlmCall({
                surface: "complete",
                ok: false,
                failed_model: model,
                fallback_depth: i,
                attempted: chain.slice(0, i + 1),
                skipped,
                error_class: classifyLlmError(err),
                latency_ms: Date.now() - startedAt,
            });
            throw err;
        }
    }
    logLlmCall({
        surface: "complete",
        ok: false,
        error_class: "chain_exhausted",
        attempted: chain,
        skipped,
        latency_ms: Date.now() - startedAt,
    });
    throw lastError instanceof Error ? lastError : new Error("all models in the fallback chain failed");
}

/**
 * Invoke exactly the requested model once. This is intentionally separate from
 * completeText's resilience fallback: callers such as the model council depend
 * on provider/model diversity and must never silently substitute a member.
 */
export async function completeTextStrict(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
    reasoningEffort?: ReasoningEffort;
}): Promise<string> {
    const model = params.model?.trim();
    if (!model) throw new Error("A model is required for strict completion.");
    const startedAt = Date.now();
    try {
        const result = await invokeComplete(model, params);
        if (isEmptyResult(result)) throw new Error(`empty response from ${model}`);
        logLlmCall({
            surface: "complete_strict",
            ok: true,
            answered: model,
            fallback_depth: 0,
            attempted: [model],
            empty: false,
            latency_ms: Date.now() - startedAt,
        });
        return result;
    } catch (error) {
        logLlmCall({
            surface: "complete_strict",
            ok: false,
            failed_model: model,
            fallback_depth: 0,
            attempted: [model],
            error_class: classifyLlmError(error),
            latency_ms: Date.now() - startedAt,
        });
        throw error;
    }
}
