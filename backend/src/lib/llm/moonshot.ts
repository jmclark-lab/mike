/**
 * Moonshot / Kimi adapter.
 *
 * Kimi K3.1 Pro is an OpenAI-compatible chat model at
 * https://api.moonshot.ai/v1. It is selectable only while
 * KIMI_K31_PRO_ENABLED is on, it is not a council seat, and this module
 * does not read a user API key. MOONSHOT_API_KEY is consulted only when a
 * call is actually made, and nothing in the repo sets it.
 */

import type {
  NormalizedToolCall,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { buildKimiChatBody } from "./requestParams";

export const DEFAULT_MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MAX_OUTPUT_TOKENS = 16384;

export type MoonshotClient = {
  provider: "moonshot";
  baseUrl: string;
  apiKey: string;
};

type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatChunk = {
  id?: string;
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    message?: { content?: string | null };
    finish_reason?: string | null;
  }[];
};

export function moonshotApiKey(): string {
  const key = process.env.MOONSHOT_API_KEY?.trim() || "";
  if (!key) {
    throw new Error(
      "Moonshot API key is not configured. Kimi K3.1 Pro has no key wired.",
    );
  }
  return key;
}

export function moonshotClient(): MoonshotClient {
  return {
    provider: "moonshot",
    baseUrl: DEFAULT_MOONSHOT_BASE_URL,
    apiKey: moonshotApiKey(),
  };
}

export function moonshotChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/chat/completions`;
}

function extractSseEvents(buffer: string): { events: ChatChunk[]; rest: string } {
  const events: ChatChunk[] = [];
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
        events.push(JSON.parse(data) as ChatChunk);
      } catch {
        // Incomplete SSE frames stay in `rest` on the next read.
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

async function postChat(params: {
  client: MoonshotClient;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Response> {
  const response = await fetch(moonshotChatCompletionsUrl(params.client.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.client.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params.body),
    signal: params.signal,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Moonshot request failed (${response.status}): ${errText || response.statusText}`,
    );
  }
  return response;
}

export async function streamMoonshot(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const { tools = [], callbacks = {}, runTools } = params;
  const maxIter = params.maxIterations ?? 10;
  const client = moonshotClient();
  const model = params.model;
  const messages: ChatMessage[] = [
    { role: "system", content: params.systemPrompt },
    ...params.messages.map((message): ChatMessage => ({
      role: message.role,
      content: message.content,
    })),
  ];
  const chatTools = tools.map((tool: OpenAIToolSchema) => ({
    type: "function" as const,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    },
  }));

  let fullText = "";
  let responseId: string | undefined;

  for (let iter = 0; iter < maxIter; iter++) {
    throwIfAborted(params.abortSignal);
    const response = await postChat({
      client,
      signal: params.abortSignal,
      body: buildKimiChatBody({
        model,
        messages,
        stream: true,
        maxTokens: MAX_OUTPUT_TOKENS,
        tools: chatTools.length ? chatTools : undefined,
      }),
    });
    if (!response.body) throw new Error("Moonshot response had no body");

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
      const parsed = extractSseEvents(buffer);
      buffer = parsed.rest;
      for (const chunk of parsed.events) {
        if (chunk.id) responseId = chunk.id;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.content === "string" && delta.content) {
          iterText += delta.content;
          fullText += delta.content;
          callbacks.onContentDelta?.(delta.content);
        }
        if (delta.tool_calls) {
          for (const call of delta.tool_calls) {
            if (!toolCallAcc.has(call.index)) {
              toolCallAcc.set(call.index, {
                id: call.id ?? "",
                name: call.function?.name ?? "",
                argumentsStr: "",
              });
            }
            const acc = toolCallAcc.get(call.index)!;
            if (call.id) acc.id = call.id;
            if (call.function?.name) acc.name = call.function.name;
            if (call.function?.arguments) acc.argumentsStr += call.function.arguments;
          }
        }
      }
    }

    if (finishReason !== "tool_calls" || toolCallAcc.size === 0 || !runTools) break;

    const normalizedCalls: NormalizedToolCall[] = [];
    const assistantToolCalls: NonNullable<
      Extract<ChatMessage, { role: "assistant" }>["tool_calls"]
    > = [];
    for (const acc of toolCallAcc.values()) {
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
      provider_name: "moonshot",
      model_name: model,
      ...(responseId ? { provider_response_id: responseId } : {}),
    },
  };
}

export async function completeMoonshotText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const client = moonshotClient();
  const messages: ChatMessage[] = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  messages.push({ role: "user", content: params.user });
  const response = await postChat({
    client,
    body: buildKimiChatBody({
      model: params.model,
      messages,
      stream: true,
      maxTokens: params.maxTokens ?? 512,
    }),
  });
  if (!response.body) throw new Error("Moonshot response had no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = extractSseEvents(buffer);
    buffer = parsed.rest;
    for (const chunk of parsed.events) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    }
  }
  return text;
}
