/**
 * DeepSeek provider adapter.
 *
 * DeepSeek exposes an OpenAI-compatible Chat Completions API at
 * https://api.deepseek.com (also accepts /v1). This is the same transport as
 * Sakana Fugu, not the OpenAI/xAI Responses API. DeepSeek is selectable in
 * chat and completions when DEEPSEEK_API_KEY is set. It is not in the default
 * fallback chain and is not a legal-council seat.
 */

import type {
    NormalizedToolCall,
    OpenAIToolSchema,
    ReasoningEffort,
    StreamChatParams,
    StreamChatResult,
} from "./types";

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const MAX_OUTPUT_TOKENS = 16384;

export type DeepSeekClient = {
    provider: "deepseek";
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

type ChatCompletionsChunk = {
    id?: string;
    choices?: {
        delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: {
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
            }[];
        };
        finish_reason?: string | null;
    }[];
};

export function deepseekApiKey(override?: string | null): string {
    const key = override?.trim() || process.env.DEEPSEEK_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "DeepSeek API key is not configured. Set DEEPSEEK_API_KEY or add a user DeepSeek key.",
        );
    }
    return key;
}

export function deepseekBaseUrl(): string {
    return (process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL).replace(
        /\/$/,
        "",
    );
}

export function deepseekClient(override?: string | null): DeepSeekClient {
    return {
        provider: "deepseek",
        baseUrl: deepseekBaseUrl(),
        apiKey: deepseekApiKey(override),
    };
}

export function deepseekChatCompletionsUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function thinkingPayload(params: {
    enableThinking?: boolean;
    reasoningEffort?: ReasoningEffort;
}): { thinking: { type: "enabled" | "disabled" }; reasoning_effort?: "low" | "high" | "max" } {
    if (params.reasoningEffort === "none" || params.reasoningEffort === "minimal") {
        return { thinking: { type: "disabled" } };
    }
    if (params.reasoningEffort) {
        const effort =
            params.reasoningEffort === "low"
                ? "low"
                : params.reasoningEffort === "xhigh"
                  ? "max"
                  : "high";
        return { thinking: { type: "enabled" }, reasoning_effort: effort };
    }
    if (params.enableThinking) {
        return { thinking: { type: "enabled" } };
    }
    return { thinking: { type: "disabled" } };
}

function extractSseEvents(buffer: string): { events: ChatCompletionsChunk[]; rest: string } {
    const events: ChatCompletionsChunk[] = [];
    const chunks = buffer.split(/\n\n/);
    const rest = chunks.pop() ?? "";
    for (const chunk of chunks) {
        const dataLines = chunk
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());
        for (const data of dataLines) {
            if (!data || data === "[DONE]") continue;
            try {
                events.push(JSON.parse(data) as ChatCompletionsChunk);
            } catch {
                // incomplete chunk — ignore and let the next buffer flush handle it
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

export async function streamDeepSeek(params: StreamChatParams): Promise<StreamChatResult> {
    const { tools = [], callbacks = {}, runTools, apiKeys } = params;
    const maxIter = params.maxIterations ?? 10;
    const client = deepseekClient(apiKeys?.deepseek);
    const model = params.model;

    const systemMessage: ChatMessage = { role: "system", content: params.systemPrompt };
    let messages: ChatMessage[] = [
        systemMessage,
        ...params.messages.map((m): ChatMessage => ({ role: m.role, content: m.content })),
    ];

    const chatTools: ChatCompletionsTool[] = tools.map((t: OpenAIToolSchema) => ({
        type: "function",
        function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        },
    }));

    let fullText = "";
    let responseId: string | undefined;
    let sawReasoning = false;

    for (let iter = 0; iter < maxIter; iter++) {
        throwIfAborted(params.abortSignal);

        const response = await fetch(deepseekChatCompletionsUrl(client.baseUrl), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${client.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model,
                messages,
                stream: true,
                max_tokens: MAX_OUTPUT_TOKENS,
                ...thinkingPayload({ enableThinking: params.enableThinking }),
                ...(chatTools.length ? { tools: chatTools, tool_choice: "auto" } : {}),
            }),
            signal: params.abortSignal,
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(
                `DeepSeek request failed (${response.status}): ${errText || response.statusText}`,
            );
        }
        if (!response.body) throw new Error("DeepSeek response had no body");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        const toolCallAcc = new Map<
            number,
            { id: string; name: string; argumentsStr: string }
        >();
        let finishReason: string | null = null;
        let iterText = "";

        while (true) {
            throwIfAborted(params.abortSignal);
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const { events, rest } = extractSseEvents(buffer);
            buffer = rest;

            for (const chunk of events) {
                if (chunk.id) responseId = chunk.id;
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                if (choice.finish_reason) finishReason = choice.finish_reason;

                const delta = choice.delta;
                if (!delta) continue;

                if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
                    sawReasoning = true;
                    callbacks.onReasoningDelta?.(delta.reasoning_content);
                }

                if (typeof delta.content === "string" && delta.content) {
                    iterText += delta.content;
                    fullText += delta.content;
                    callbacks.onContentDelta?.(delta.content);
                }

                if (delta.tool_calls) {
                    for (const tc of delta.tool_calls) {
                        const idx = tc.index;
                        if (!toolCallAcc.has(idx)) {
                            toolCallAcc.set(idx, {
                                id: tc.id ?? "",
                                name: tc.function?.name ?? "",
                                argumentsStr: "",
                            });
                        }
                        const acc = toolCallAcc.get(idx)!;
                        if (tc.id) acc.id = tc.id;
                        if (tc.function?.name) acc.name = tc.function.name;
                        if (tc.function?.arguments) acc.argumentsStr += tc.function.arguments;
                    }
                }
            }
        }

        if (sawReasoning) {
            callbacks.onReasoningBlockEnd?.();
            sawReasoning = false;
        }

        if (finishReason !== "tool_calls" || toolCallAcc.size === 0 || !runTools) break;

        const normalizedCalls: NormalizedToolCall[] = [];
        const assistantToolCalls: AssistantToolCall[] = [];

        for (const [, acc] of toolCallAcc) {
            let input: Record<string, unknown> = {};
            try {
                const parsed: unknown = JSON.parse(acc.argumentsStr || "{}");
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                    input = parsed as Record<string, unknown>;
                }
            } catch {
                // malformed JSON — proceed with empty input
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
            content: iterText || null,
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
            provider_name: "deepseek",
            model_name: model,
            ...(responseId ? { provider_response_id: responseId } : {}),
        },
    };
}

export async function completeDeepSeekText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { deepseek?: string | null };
    reasoningEffort?: ReasoningEffort;
}): Promise<string> {
    const client = deepseekClient(params.apiKeys?.deepseek);
    const messages: ChatMessage[] = [];
    if (params.systemPrompt) messages.push({ role: "system", content: params.systemPrompt });
    messages.push({ role: "user", content: params.user });

    const response = await fetch(deepseekChatCompletionsUrl(client.baseUrl), {
        method: "POST",
        headers: {
            Authorization: `Bearer ${client.apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: params.model,
            messages,
            max_tokens: params.maxTokens ?? 512,
            stream: true,
            ...thinkingPayload({ reasoningEffort: params.reasoningEffort }),
        }),
    });

    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(
            `DeepSeek request failed (${response.status}): ${errText || response.statusText}`,
        );
    }
    if (!response.body) throw new Error("DeepSeek response had no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";

    const consume = (events: ChatCompletionsChunk[]) => {
        for (const chunk of events) {
            const content = chunk.choices?.[0]?.delta?.content;
            if (typeof content === "string") text += content;
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = extractSseEvents(buffer);
        buffer = parsed.rest;
        consume(parsed.events);
    }

    buffer += decoder.decode();
    if (buffer.trim()) consume(extractSseEvents(`${buffer}\n\n`).events);
    return text;
}
