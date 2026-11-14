/**
 * NVIDIA Nemotron provider adapter.
 *
 * Nemotron 3 Ultra is an OpenAI-compatible Chat Completions model at
 * https://integrate.api.nvidia.com/v1/chat/completions. NVIDIA has no
 * /responses endpoint, so this does not use the xAI/OpenAI Responses client.
 * The model is selectable in chat and on ask_mike. It is not in the default
 * fallback chain and it is not a legal-council seat.
 *
 * Thinking is requested with chat_template_kwargs.enable_thinking. Reasoning
 * tokens stay on the reasoning callback, the same split DeepSeek and xAI use,
 * and are not copied into the user-visible answer.
 *
 * A missing NVIDIA_API_KEY throws before any request, matching the other
 * providers. Abort and HTTP failures propagate with the status or abort
 * wording the shared fallback classifier already treats as retryable. A
 * strict (pinned) call does not fall back; that decision lives in index.ts,
 * the same place it does for xAI.
 */

import type {
    NormalizedToolCall,
    OpenAIToolSchema,
    StreamChatParams,
    StreamChatResult,
} from "./types";

export const DEFAULT_NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const MAX_OUTPUT_TOKENS = 16384;

export type NvidiaClient = {
    provider: "nvidia";
    baseUrl: string;
    apiKey: string;
};

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

type ChatCompletionsTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
    };
};

type ToolCallDelta = {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
};

type ContentDelta = {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: ToolCallDelta[];
};

type ChatCompletionsChunk = {
    id?: string;
    error?: { message?: string; code?: string | number; type?: string } | string;
    choices?: {
        delta?: ContentDelta;
        message?: ContentDelta & { tool_calls?: ToolCallDelta[] };
        finish_reason?: string | null;
    }[];
};

type ToolAcc = { id: string; name: string; argumentsStr: string };

export function nvidiaApiKey(override?: string | null): string {
    const key = override?.trim() || process.env.NVIDIA_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "NVIDIA API key is not configured. Set NVIDIA_API_KEY or add a user NVIDIA key.",
        );
    }
    return key;
}

export function nvidiaBaseUrl(): string {
    return (process.env.NVIDIA_BASE_URL?.trim() || DEFAULT_NVIDIA_BASE_URL).replace(
        /\/$/,
        "",
    );
}

/** Wire model. NVIDIA_MODEL replaces the id sent to the API. */
export function nvidiaRequestModel(requested?: string | null): string {
    const override = process.env.NVIDIA_MODEL?.trim();
    if (override) return override;
    const requestedId = requested?.trim();
    if (requestedId) return requestedId;
    return DEFAULT_NVIDIA_MODEL;
}

export function nvidiaClient(override?: string | null): NvidiaClient {
    return {
        provider: "nvidia",
        baseUrl: nvidiaBaseUrl(),
        apiKey: nvidiaApiKey(override),
    };
}

export function nvidiaChatCompletionsUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function thinkingBody(): { chat_template_kwargs: { enable_thinking: true } } {
    return { chat_template_kwargs: { enable_thinking: true } };
}

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
    if (typeof error === "string") return error.trim() || "NVIDIA response failed.";
    const message =
        typeof error.message === "string" && error.message.trim()
            ? error.message.trim()
            : "NVIDIA response failed.";
    const code =
        error.code !== undefined && String(error.code).trim()
            ? String(error.code).trim()
            : "";
    return code ? `NVIDIA error (${code}): ${message}` : message;
}

function reasoningText(delta: ContentDelta | undefined): string {
    if (!delta) return "";
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        return delta.reasoning_content;
    }
    if (typeof delta.reasoning === "string" && delta.reasoning) return delta.reasoning;
    return "";
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
    client: NvidiaClient;
    body: Record<string, unknown>;
    signal?: AbortSignal;
}): Promise<Response> {
    throwIfAborted(params.signal);
    let response: Response;
    try {
        response = await fetch(nvidiaChatCompletionsUrl(params.client.baseUrl), {
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
            `NVIDIA request failed (${response.status}): ${errText || response.statusText}`,
        );
    }
    return response;
}

function absorbToolCall(acc: Map<number, ToolAcc>, call: ToolCallDelta): void {
    if (!acc.has(call.index)) {
        acc.set(call.index, {
            id: call.id ?? "",
            name: call.function?.name ?? "",
            argumentsStr: "",
        });
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
};

async function readCompletion(params: {
    response: Response;
    signal?: AbortSignal;
    onContent?: (text: string) => void;
    onReasoning?: (text: string) => void;
}): Promise<ReadResult> {
    if (isJsonResponse(params.response)) {
        const payload = (await params.response.json()) as ChatCompletionsChunk;
        const failure = chunkError(payload);
        if (failure) throw new Error(failure);
        const choice = payload.choices?.[0];
        const message = choice?.message ?? choice?.delta;
        const reasoning = reasoningText(message);
        const text = contentText(message);
        if (reasoning) params.onReasoning?.(reasoning);
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
        };
    }

    if (!params.response.body) throw new Error("NVIDIA response had no body");
    const reader = params.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let responseId: string | undefined;
    let finishReason: string | null = null;
    const toolCalls = new Map<number, ToolAcc>();

    const consume = (events: ChatCompletionsChunk[]) => {
        for (const chunk of events) {
            const failure = chunkError(chunk);
            if (failure) throw new Error(failure);
            if (chunk.id) responseId = chunk.id;
            const choice = chunk.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta ?? choice.message;
            const reasoning = reasoningText(delta);
            if (reasoning) params.onReasoning?.(reasoning);
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
    return { responseId, text, finishReason, toolCalls };
}

function toolSchemas(tools: OpenAIToolSchema[]): ChatCompletionsTool[] {
    return tools.map((tool) => ({
        type: "function",
        function: {
            name: tool.function.name,
            description: tool.function.description,
            parameters: tool.function.parameters,
        },
    }));
}

export async function streamNvidia(params: StreamChatParams): Promise<StreamChatResult> {
    const { tools = [], callbacks = {}, runTools, apiKeys } = params;
    const maxIter = params.maxIterations ?? 10;
    const client = nvidiaClient(apiKeys?.nvidia);
    const model = nvidiaRequestModel(params.model);
    const messages: ChatMessage[] = [
        { role: "system", content: params.systemPrompt },
        ...params.messages.map((message): ChatMessage => ({
            role: message.role,
            content: message.content,
        })),
    ];
    const chatTools = toolSchemas(tools);

    let fullText = "";
    let responseId: string | undefined;

    for (let iter = 0; iter < maxIter; iter++) {
        throwIfAborted(params.abortSignal);
        const response = await postChat({
            client,
            signal: params.abortSignal,
            body: {
                model,
                messages,
                stream: true,
                max_tokens: MAX_OUTPUT_TOKENS,
                ...thinkingBody(),
                ...(chatTools.length ? { tools: chatTools, tool_choice: "auto" } : {}),
            },
        });
        let sawReasoning = false;
        const read = await readCompletion({
            response,
            signal: params.abortSignal,
            onContent: (piece) => {
                fullText += piece;
                callbacks.onContentDelta?.(piece);
            },
            onReasoning: (piece) => {
                sawReasoning = true;
                callbacks.onReasoningDelta?.(piece);
            },
        });
        if (read.responseId) responseId = read.responseId;
        if (sawReasoning) callbacks.onReasoningBlockEnd?.();

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
        messages.push({
            role: "assistant",
            content: read.text || null,
            tool_calls: assistantToolCalls,
        });
        const results = await runTools(normalizedCalls);
        throwIfAborted(params.abortSignal);
        for (const result of results) {
            messages.push({
                role: "tool",
                tool_call_id: result.tool_use_id,
                content: result.content,
            });
        }
    }

    return {
        fullText,
        providerMetadata: {
            provider_name: "nvidia",
            model_name: model,
            ...(responseId ? { provider_response_id: responseId } : {}),
        },
    };
}

export async function completeNvidiaText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { nvidia?: string | null };
}): Promise<string> {
    const client = nvidiaClient(params.apiKeys?.nvidia);
    const messages: ChatMessage[] = [];
    if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt });
    messages.push({ role: "user", content: params.user });
    const response = await postChat({
        client,
        body: {
            model: nvidiaRequestModel(params.model),
            messages,
            max_tokens: params.maxTokens ?? 512,
            stream: true,
            ...thinkingBody(),
        },
    });
    const read = await readCompletion({ response });
    return read.text;
}
