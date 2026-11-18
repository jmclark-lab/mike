/**
 * Perplexity Orchestrator provider adapter (OFF by default).
 *
 * One Perplexity API key, many models, OpenAI Chat Completions wire format, per-token billing at the pinned model's
 * published rate (docs.perplexity.ai/docs/orchestrator/quickstart). Mike addresses a model as
 * `orchestrator/<vendor>/<model>` (see orchestratorIds.ts) and always sends the explicit catalog id, never
 * `perplexity/auto`.
 *
 * Switched on only when ORCHESTRATOR_ENABLED is exactly "true" after trimming AND a key is set
 * (ORCHESTRATOR_API_KEY, else PERPLEXITY_API_KEY). It is never an unpinned-chain hop by default, never a council seat or
 * judge, and it is refused while Sponsor-CI mode is on (see assertOrchestratorSelectable), because Perplexity's
 * zero-data-retention is off by default and needs a written agreement (docs.perplexity.ai/docs/resources/privacy-security).
 * The Claude Code / Codex subscription second-opinion seats are outside this repo and do not touch this adapter.
 *
 * The API is stateless (no previous_response_id), so this uses Chat Completions and replays the full message list on
 * every tool iteration, like the NVIDIA adapter. Reasoning tokens count against max_completion_tokens: a 400 token cap
 * returned empty content for gpt-6-luna and claude-haiku-5-5 on 2026-11-18, so completions are floored at 4096.
 * reasoning_content is discarded. An empty answer throws so the shared fallback path can retry.
 */

import type {
    AskEffort,
    NormalizedToolCall,
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
} from "./types";
import { isOrchestratorModelId, orchestratorWireModel } from "./orchestratorIds";
import { tokenPriceForModel } from "./pricing";

export const DEFAULT_ORCHESTRATOR_BASE_URL = "https://api.perplexity.ai/orchestrator/v1";
const ORCHESTRATOR_DEFAULT_OUTPUT_TOKENS = 16384;
/** Reasoning shares the completion budget; below this, content often comes back null. */
export const ORCHESTRATOR_MIN_OUTPUT_TOKENS = 4096;

export type OrchestratorClient = {
    provider: "orchestrator";
    baseUrl: string;
    apiKey: string;
};

export function isOrchestratorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.ORCHESTRATOR_ENABLED?.trim() === "true";
}

export function orchestratorApiKey(env: NodeJS.ProcessEnv = process.env): string {
    return env.ORCHESTRATOR_API_KEY?.trim() || env.PERPLEXITY_API_KEY?.trim() || "";
}

export function orchestratorBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
    return (env.ORCHESTRATOR_BASE_URL?.trim() || DEFAULT_ORCHESTRATOR_BASE_URL).replace(/\/$/, "");
}

/** The flag is on and a key is present. Used to keep unready ids off chains without throwing. */
export function isOrchestratorReady(env: NodeJS.ProcessEnv = process.env): boolean {
    return isOrchestratorEnabled(env) && Boolean(orchestratorApiKey(env));
}

/**
 * Throws before any request when the id cannot be used: malformed or perplexity/auto, the flag is off, no key, or
 * Sponsor-CI is on. The caller passes `sponsorCi` so this file does not import the Sponsor-CI module (which imports models).
 */
export function assertOrchestratorSelectable(
    model: string,
    opts: { sponsorCi: boolean },
    env: NodeJS.ProcessEnv = process.env,
): void {
    if (!isOrchestratorModelId(model)) return;
    if (!orchestratorWireModel(model)) {
        throw new Error(
            `Orchestrator model "${model.trim()}" is not a pinned id. Use orchestrator/<vendor>/<model> with an explicit catalog id. perplexity/auto is refused.`,
        );
    }
    if (opts.sponsorCi) {
        throw new Error(
            `Sponsor-CI mode refuses ${model.trim()}. Perplexity Orchestrator traffic is not allowed for sponsor documents: zero data retention is not enabled for this account.`,
        );
    }
    if (!isOrchestratorEnabled(env)) {
        throw new Error(
            `Perplexity Orchestrator is switched off (${model.trim()}). Set ORCHESTRATOR_ENABLED=true to pin it. The pin is rejected and does not fall back to another model.`,
        );
    }
    if (!orchestratorApiKey(env)) {
        throw new Error(
            `Perplexity Orchestrator pin ${model.trim()} requires ORCHESTRATOR_API_KEY or PERPLEXITY_API_KEY. None is configured, so the pin is rejected and does not fall back to another model.`,
        );
    }
}

export function orchestratorClient(env: NodeJS.ProcessEnv = process.env): OrchestratorClient {
    const apiKey = orchestratorApiKey(env);
    if (!apiKey) {
        throw new Error("Perplexity Orchestrator API key is not configured. Set ORCHESTRATOR_API_KEY or PERPLEXITY_API_KEY.");
    }
    return { provider: "orchestrator", baseUrl: orchestratorBaseUrl(env), apiKey };
}

export function orchestratorChatCompletionsUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

export function orchestratorOutputTokens(requested?: number): number {
    if (requested == null || !Number.isFinite(requested)) return ORCHESTRATOR_DEFAULT_OUTPUT_TOKENS;
    return Math.max(ORCHESTRATOR_MIN_OUTPUT_TOKENS, Math.trunc(requested));
}

/** Orchestrator reasoning_effort takes none..max; ask_mike's four values pass through unchanged. Omitted sends nothing. */
export function orchestratorReasoningEffort(effort?: AskEffort): AskEffort | undefined {
    return effort;
}

/** USD for one call from Mike's published rate table (pricing.ts), or null when the model has no entry. */
export function orchestratorUsageCostUsd(
    wireModel: string,
    tokIn: number | null,
    tokOut: number | null,
): number | null {
    const bare = wireModel.split("/").pop() ?? wireModel;
    const price = tokenPriceForModel(bare);
    if (!price || tokIn == null || tokOut == null) return null;
    const usd = (tokIn * price.inputUsdPerMillion + tokOut * price.outputUsdPerMillion) / 1_000_000;
    return Math.round(usd * 1e6) / 1e6;
}

type AssistantToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
};

type ChatMessage =
    | { role: "system"; content: string }
    | { role: "user"; content: string }
    | { role: "assistant"; content: string | null; tool_calls?: AssistantToolCall[] }
    | { role: "tool"; tool_call_id: string; content: string };

type ToolCallDelta = {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
};

type ContentDelta = {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: ToolCallDelta[];
};

type ChatCompletionsChunk = {
    id?: string;
    error?: { message?: string; code?: string | number; type?: string } | string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    choices?: {
        delta?: ContentDelta;
        message?: ContentDelta;
        finish_reason?: string | null;
    }[];
};

type ToolAcc = { id: string; name: string; argumentsStr: string };

function extractSseEvents(buffer: string): { events: ChatCompletionsChunk[]; rest: string } {
    const events: ChatCompletionsChunk[] = [];
    const chunks = buffer.split(/\n\n/);
    const rest = chunks.pop() ?? "";
    for (const chunk of chunks) {
        const dataLines = chunk
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim());
        for (const data of dataLines) {
            if (!data || data === "[DONE]") continue;
            try {
                events.push(JSON.parse(data) as ChatCompletionsChunk);
            } catch {
                // Incomplete SSE frames stay in `rest` until the next read.
            }
        }
    }
    return { events, rest };
}

function abortError(): Error {
    const err = new Error("Stream aborted.");
    err.name = "AbortError";
    return err;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError();
}

function chunkError(chunk: ChatCompletionsChunk): string | null {
    const error = chunk.error;
    if (!error) return null;
    if (typeof error === "string") return error.trim() || "Orchestrator response failed.";
    const message =
        typeof error.message === "string" && error.message.trim()
            ? error.message.trim()
            : "Orchestrator response failed.";
    const code = error.code !== undefined && String(error.code).trim() ? String(error.code).trim() : "";
    return code ? `Orchestrator error (${code}): ${message}` : message;
}

function contentText(delta: ContentDelta | undefined): string {
    if (!delta || typeof delta.content !== "string") return "";
    return delta.content;
}

function isJsonResponse(response: Response): boolean {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    return contentType.includes("application/json") && !contentType.includes("text/event-stream");
}

async function postChat(params: {
    client: OrchestratorClient;
    body: Record<string, unknown>;
    signal?: AbortSignal;
}): Promise<Response> {
    throwIfAborted(params.signal);
    let response: Response;
    try {
        response = await fetch(orchestratorChatCompletionsUrl(params.client.baseUrl), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${params.client.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(params.body),
            signal: params.signal,
        });
    } catch (err) {
        throwIfAborted(params.signal);
        throw err;
    }
    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(
            `Orchestrator request failed (${response.status}): ${(errText || response.statusText).slice(0, 500)}`,
        );
    }
    return response;
}

function absorbToolCall(acc: Map<number, ToolAcc>, call: ToolCallDelta): void {
    if (!acc.has(call.index)) {
        acc.set(call.index, { id: call.id ?? "", name: call.function?.name ?? "", argumentsStr: "" });
    }
    const slot = acc.get(call.index)!;
    if (call.id) slot.id = call.id;
    if (call.function?.name) slot.name = call.function.name;
    if (call.function?.arguments) slot.argumentsStr += call.function.arguments;
}

type ReadResult = {
    responseId?: string;
    text: string;
    finishReason: string | null;
    toolCalls: Map<number, ToolAcc>;
    tokIn: number | null;
    tokOut: number | null;
};

async function readCompletion(params: {
    response: Response;
    signal?: AbortSignal;
    onContent?: (text: string) => void;
}): Promise<ReadResult> {
    if (isJsonResponse(params.response)) {
        const payload = (await params.response.json()) as ChatCompletionsChunk;
        const failure = chunkError(payload);
        if (failure) throw new Error(failure);
        const choice = payload.choices?.[0];
        const message = choice?.message ?? choice?.delta;
        const text = contentText(message);
        if (text) params.onContent?.(text);
        const toolCalls = new Map<number, ToolAcc>();
        for (const [index, call] of (message?.tool_calls ?? []).entries()) {
            absorbToolCall(toolCalls, { ...call, index: call.index ?? index });
        }
        return {
            responseId: payload.id,
            text,
            finishReason: choice?.finish_reason ?? null,
            toolCalls,
            tokIn: payload.usage?.prompt_tokens ?? null,
            tokOut: payload.usage?.completion_tokens ?? null,
        };
    }

    if (!params.response.body) throw new Error("Orchestrator response had no body");
    const reader = params.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let responseId: string | undefined;
    let finishReason: string | null = null;
    let tokIn: number | null = null;
    let tokOut: number | null = null;
    const toolCalls = new Map<number, ToolAcc>();

    const consume = (events: ChatCompletionsChunk[]) => {
        for (const chunk of events) {
            const failure = chunkError(chunk);
            if (failure) throw new Error(failure);
            if (chunk.id) responseId = chunk.id;
            if (chunk.usage) {
                tokIn = chunk.usage.prompt_tokens ?? tokIn;
                tokOut = chunk.usage.completion_tokens ?? tokOut;
            }
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta ?? choice.message;
            const piece = contentText(delta);
            if (piece) {
                text += piece;
                params.onContent?.(piece);
            }
            for (const call of delta?.tool_calls ?? []) absorbToolCall(toolCalls, call);
        }
    };

    while (true) {
        throwIfAborted(params.signal);
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = extractSseEvents(buffer);
        buffer = parsed.rest;
        consume(parsed.events);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(extractSseEvents(`${buffer}\n\n`).events);
    return { responseId, text, finishReason, toolCalls, tokIn, tokOut };
}

function toolSchemas(tools: OpenAIToolSchema[]) {
    return tools.map((tool) => ({
        type: "function" as const,
        function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
        },
    }));
}

/** One JSON line per call: model, token counts, USD from pricing.ts when the model has a rate, latency. No prompt text. */
function logOrchestratorCall(payload: {
    surface: "stream" | "complete";
    wireModel: string;
    tokIn: number | null;
    tokOut: number | null;
    latencyMs: number;
    ok: boolean;
}): void {
    try {
        console.log(
            "[orchestrator.telemetry] " +
                JSON.stringify({
                    event: "orchestrator_call",
                    surface: payload.surface,
                    model: payload.wireModel,
                    ok: payload.ok,
                    tok_in: payload.tokIn,
                    tok_out: payload.tokOut,
                    cost_usd: orchestratorUsageCostUsd(payload.wireModel, payload.tokIn, payload.tokOut),
                    latency_ms: payload.latencyMs,
                }),
        );
    } catch {
        /* never let logging break a request */
    }
}

function requireWireModel(model: string): string {
    const wire = orchestratorWireModel(model);
    if (!wire) {
        throw new Error(`Orchestrator model "${model.trim()}" is not a pinned id (orchestrator/<vendor>/<model>).`);
    }
    return wire;
}

export async function streamOrchestrator(params: StreamChatParams): Promise<StreamChatResult> {
    const { tools = [], callbacks = {}, runTools } = params;
    const maxIter = params.maxIterations ?? 10;
    const client = orchestratorClient();
    const wireModel = requireWireModel(params.model);
    const effort = orchestratorReasoningEffort(params.effort);
    const messages: ChatMessage[] = [
        { role: "system", content: params.systemPrompt },
        ...params.messages.map((message): ChatMessage => ({ role: message.role, content: message.content })),
    ];
    const chatTools = toolSchemas(tools);
    const startedAt = Date.now();

    let fullText = "";
    let responseId: string | undefined;
    let tokIn: number | null = null;
    let tokOut: number | null = null;
    let ok = false;
    try {
        for (let iter = 0; iter < maxIter; iter++) {
            throwIfAborted(params.abortSignal);
            const response = await postChat({
                client,
                signal: params.abortSignal,
                body: {
                    model: wireModel,
                    messages,
                    stream: true,
                    stream_options: { include_usage: true },
                    max_completion_tokens: orchestratorOutputTokens(),
                    ...(effort ? { reasoning_effort: effort } : {}),
                    ...(chatTools.length ? { tools: chatTools, tool_choice: "auto" } : {}),
                },
            });
            const read = await readCompletion({
                response,
                signal: params.abortSignal,
                onContent: (piece) => {
                    fullText += piece;
                    callbacks.onContentDelta?.(piece);
                },
            });
            if (read.responseId) responseId = read.responseId;
            if (read.tokIn != null) tokIn = (tokIn ?? 0) + read.tokIn;
            if (read.tokOut != null) tokOut = (tokOut ?? 0) + read.tokOut;

            if (read.finishReason !== "tool_calls" || read.toolCalls.size === 0 || !runTools) break;

            const normalizedCalls: NormalizedToolCall[] = [];
            const assistantToolCalls: AssistantToolCall[] = [];
            for (const acc of read.toolCalls.values()) {
                let input: Record<string, unknown> = {};
                try {
                    const parsed: unknown = JSON.parse(acc.argumentsStr || "{}");
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        input = parsed as Record<string, unknown>;
                    }
                } catch {
                    input = {};
                }
                const call: NormalizedToolCall = { id: acc.id, name: acc.name, input };
                callbacks.onToolCallStart?.(call);
                normalizedCalls.push(call);
                assistantToolCalls.push({
                    id: acc.id,
                    type: "function",
                    function: { name: acc.name, arguments: acc.argumentsStr },
                });
            }
            messages.push({ role: "assistant", content: read.text || null, tool_calls: assistantToolCalls });
            const results = await runTools(normalizedCalls);
            throwIfAborted(params.abortSignal);
            for (const result of results) {
                messages.push({ role: "tool", tool_call_id: result.tool_use_id, content: result.content });
            }
        }
        if (!fullText.trim()) throw new Error("Orchestrator returned an empty response.");
        ok = true;
    } finally {
        logOrchestratorCall({ surface: "stream", wireModel, tokIn, tokOut, latencyMs: Date.now() - startedAt, ok });
    }
    return {
        fullText,
        providerMetadata: {
            provider_name: "orchestrator",
            model_name: params.model.trim(),
            ...(responseId ? { provider_response_id: responseId } : {}),
        },
    };
}

export async function completeOrchestratorText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    effort?: AskEffort;
}): Promise<string> {
    const client = orchestratorClient();
    const wireModel = requireWireModel(params.model);
    const effort = orchestratorReasoningEffort(params.effort);
    const messages: ChatMessage[] = [];
    if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt });
    messages.push({ role: "user", content: params.user });
    const startedAt = Date.now();
    let read: ReadResult | undefined;
    try {
        const response = await postChat({
            client,
            body: {
                model: wireModel,
                messages,
                max_completion_tokens: orchestratorOutputTokens(params.maxTokens ?? ORCHESTRATOR_MIN_OUTPUT_TOKENS),
                stream: true,
                stream_options: { include_usage: true },
                ...(effort ? { reasoning_effort: effort } : {}),
            },
        });
        read = await readCompletion({ response });
        if (!read.text.trim()) throw new Error("Orchestrator returned an empty response.");
        return read.text;
    } finally {
        logOrchestratorCall({
            surface: "complete",
            wireModel,
            tokIn: read?.tokIn ?? null,
            tokOut: read?.tokOut ?? null,
            latencyMs: Date.now() - startedAt,
            ok: Boolean(read?.text.trim()),
        });
    }
}
