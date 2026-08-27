import { streamSakana, completeSakanaText } from "./sakana";
import { streamClaude, completeClaudeText } from "./claude";
import { completeGeminiText, streamGemini } from "./gemini";
import { completeOpenAIText, streamOpenAI } from "./openai";
import { DEFAULT_SAKANA_MODEL, providerForModel } from "./models";
import type { LlmUsage, ReasoningEffort, StreamChatParams, StreamChatResult, UserApiKeys } from "./types";
import { isGroundingEnabled, buildGroundingContext } from "../hybridSearch";
import {
    DEFAULT_ROUTE_MODEL,
    HIGH_ROUTE_MODEL,
    buildRoutedChain,
    classifyIntent,
    firstModelForBucket,
    lastUserText,
    type RouteBucket,
} from "./intentRouter";

export * from "./types";
export * from "./models";
export {
    DEFAULT_ROUTE_MODEL,
    HIGH_ROUTE_MODEL,
    classifyIntent,
    firstModelForBucket,
    buildRoutedChain,
    lastUserText,
} from "./intentRouter";
export type { RouteBucket, IntentClassification, IntentInput } from "./intentRouter";

const DEFAULT_FABLE_MODEL = "claude-fable-5";
const STRONG_LEGAL_MODEL = HIGH_ROUTE_MODEL;
const FINAL_OPENAI_FALLBACK = "gpt-5.6-sol";

/**
 * Configured pool primary. Fugu Ultra remains the default lead (Julio):
 * Sakana prices Fugu Ultra well below Fable 5 at the same intelligence
 * class, and Fugu is an orchestrator over a model pool.
 */
function resolveActiveModel(): string {
    const explicit = process.env.LLM_MODEL?.trim();
    if (explicit) return explicit;
    if (process.env.LLM_PROVIDER?.trim().toLowerCase() === "anthropic") {
        return DEFAULT_FABLE_MODEL;
    }
    return process.env.SAKANA_MODEL?.trim() || DEFAULT_SAKANA_MODEL;
}

/**
 * Configured fallback pool. Default when env is unset:
 *   fugu-ultra-20260615 → claude-fable-5 → claude-opus-4-8 → gpt-5.6-sol
 *
 * Intent routing picks the FIRST seat (Fugu for default/cheap, Opus for
 * signed-document work), then this pool is health-reordered behind it.
 *
 * LLM_MODEL overrides the pool primary. LLM_FALLBACK_MODEL replaces the tail.
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
        push(process.env.SAKANA_MODEL?.trim() || DEFAULT_SAKANA_MODEL);
        push(DEFAULT_FABLE_MODEL);
        push(STRONG_LEGAL_MODEL);
        push(FINAL_OPENAI_FALLBACK);
    }

    return chain;
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

function providerConfigured(name: "ANTHROPIC" | "SAKANA" | "OPENAI" | "GEMINI"): boolean {
    return Boolean(process.env[`${name}_API_KEY`]?.trim());
}

// Snapshot of the routing/cooldown state for /healthz and telemetry.
export function getRoutingHealth(): {
    chain: string[];
    first_model_by_bucket: Record<RouteBucket, string>;
    coolingDown: { model: string; ms_remaining: number; failures: number }[];
    providers_configured: {
        anthropic: boolean;
        sakana: boolean;
        openai: boolean;
        gemini: boolean;
    };
    search_router_mode: string;
} {
    const now = Date.now();
    const coolingDown = [...modelCooldownUntil.entries()]
        .filter(([, until]) => until > now)
        .map(([model, until]) => ({
            model,
            ms_remaining: until - now,
            failures: modelFailureStreak.get(model) ?? 0,
        }));
    return {
        chain: resolveModelChain(),
        first_model_by_bucket: {
            high: firstModelForBucket("high"),
            cheap: firstModelForBucket("cheap"),
            default: firstModelForBucket("default"),
        },
        coolingDown,
        providers_configured: {
            anthropic: providerConfigured("ANTHROPIC"),
            sakana: providerConfigured("SAKANA"),
            openai: providerConfigured("OPENAI"),
            gemini: providerConfigured("GEMINI"),
        },
        // Reported only — SEARCH_ROUTER_MODE is not flipped in this change.
        search_router_mode: process.env.SEARCH_ROUTER_MODE?.trim().toLowerCase() || "off",
    };
}

export function resetRoutingHealthForTests(): void {
    modelCooldownUntil.clear();
    modelFailureStreak.clear();
}

function usageFields(usage?: LlmUsage): Record<string, number> {
    if (!usage) return {};
    const out: Record<string, number> = {};
    if (typeof usage.input_tokens === "number") out.input_tokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") out.output_tokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === "number") {
        out.cache_read_input_tokens = usage.cache_read_input_tokens;
    }
    if (typeof usage.cache_creation_input_tokens === "number") {
        out.cache_creation_input_tokens = usage.cache_creation_input_tokens;
    }
    return out;
}

async function invokeStream(
    model: string,
    params: StreamChatParams & { systemPrompt?: string },
): Promise<StreamChatResult> {
    const provider = providerForModel(model);
    if (provider === "claude") return streamClaude({ ...params, model });
    if (provider === "openai") return streamOpenAI({ ...params, model });
    if (provider === "gemini") return streamGemini({ ...params, model });
    return streamSakana({ ...params, model });
}

/**
 * Try models in order. Empty / retryable misses mark the model unhealthy
 * and continue. Exported so tests can prove fallback still runs after
 * the intent-picked first model misses.
 */
export async function runFallbackChain<T>(opts: {
    chain: string[];
    invoke: (model: string) => Promise<T>;
    isEmpty: (result: T) => boolean;
}): Promise<{ result: T; answered: string; fallbackDepth: number; attempted: string[] }> {
    const { chain, invoke, isEmpty } = opts;
    let lastError: unknown;
    for (let i = 0; i < chain.length; i++) {
        const model = chain[i];
        const isLast = i === chain.length - 1;
        try {
            const result = await invoke(model);
            if (isEmpty(result)) {
                markModelUnhealthy(model);
                if (!isLast) {
                    console.warn(`[llm] ${model} returned an empty response; falling back to ${chain[i + 1]}`);
                    lastError = new Error(`empty response from ${model}`);
                    continue;
                }
            } else {
                markModelHealthy(model);
            }
            if (i > 0) console.log(`[llm] answered via fallback model ${model}`);
            return {
                result,
                answered: model,
                fallbackDepth: i,
                attempted: chain.slice(0, i + 1),
            };
        } catch (err) {
            lastError = err;
            if (!isLast && isRetryableError(err)) {
                markModelUnhealthy(model);
                console.warn(
                    `[llm] ${model} failed (${err instanceof Error ? err.message : String(err)}); falling back to ${chain[i + 1]}`,
                );
                continue;
            }
            throw err;
        }
    }
    throw lastError instanceof Error ? lastError : new Error("all models in the fallback chain failed");
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

    const intent = classifyIntent({ userText: lastUserText(params.messages) });
    const routed = buildRoutedChain({
        bucket: intent.bucket,
        fallbackPool: resolveModelChain(),
        orderByHealth,
    });
    const chain = routed.chain;
    console.log(
        `[llm] route=${intent.bucket} first=${routed.firstModel} chain: ${chain.join(" -> ")}`,
    );

    const startedAt = Date.now();
    try {
        const outcome = await runFallbackChain({
            chain,
            invoke: (model) => invokeStream(model, { ...params, systemPrompt }),
            isEmpty: (result) => isEmptyResult(result.fullText),
        });
        if (!outcome.result.providerMetadata) {
            outcome.result.providerMetadata = {
                provider_name: providerForModel(outcome.answered),
                model_name: outcome.answered,
            };
        }
        logLlmCall({
            surface: "stream",
            ok: true,
            route_bucket: intent.bucket,
            route_reason: intent.reason,
            first_model: routed.firstModel,
            answered: outcome.answered,
            fallback_depth: outcome.fallbackDepth,
            attempted: outcome.attempted,
            empty: isEmptyResult(outcome.result.fullText),
            latency_ms: Date.now() - startedAt,
            ...usageFields(outcome.result.usage),
        });
        return outcome.result;
    } catch (err) {
        logLlmCall({
            surface: "stream",
            ok: false,
            route_bucket: intent.bucket,
            route_reason: intent.reason,
            first_model: routed.firstModel,
            failed_model: chain[0],
            fallback_depth: chain.length - 1,
            attempted: chain,
            error_class: classifyLlmError(err),
            latency_ms: Date.now() - startedAt,
        });
        throw err;
    }
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
    const intent = classifyIntent({ userText: params.user });
    const fallbackChain = orderByHealth(resolveModelChain());
    const firstModel = requested || firstModelForBucket(intent.bucket);
    const chain = requested
        ? [requested, ...fallbackChain.filter((m) => m !== requested)]
        : buildRoutedChain({
            bucket: intent.bucket,
            fallbackPool: resolveModelChain(),
            orderByHealth,
        }).chain;

    const startedAt = Date.now();
    try {
        const outcome = await runFallbackChain({
            chain,
            invoke: (model) => invokeComplete(model, params),
            isEmpty: isEmptyResult,
        });
        logLlmCall({
            surface: "complete",
            ok: true,
            route_bucket: requested ? "explicit" : intent.bucket,
            first_model: firstModel,
            answered: outcome.answered,
            fallback_depth: outcome.fallbackDepth,
            attempted: outcome.attempted,
            empty: isEmptyResult(outcome.result),
            latency_ms: Date.now() - startedAt,
        });
        return outcome.result;
    } catch (err) {
        logLlmCall({
            surface: "complete",
            ok: false,
            route_bucket: requested ? "explicit" : intent.bucket,
            first_model: firstModel,
            failed_model: chain[0],
            fallback_depth: chain.length - 1,
            attempted: chain,
            error_class: classifyLlmError(err),
            latency_ms: Date.now() - startedAt,
        });
        throw err;
    }
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
