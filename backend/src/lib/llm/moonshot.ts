/**
 * Moonshot / Kimi adapter.
 *
 * Kimi K3.1 Pro is an OpenAI-compatible chat model. Mike calls the
 * international endpoint https://api.moonshot.ai/v1 (platform.moonshot.ai
 * and platform.kimi.ai). The China console at platform.kimi.com uses
 * https://api.moonshot.cn/v1 and a different key; this module never calls
 * it. The verified provider id is `kimi-k3.1-pro`, which is also Mike's
 * public alias.
 *
 * The pin is off unless KIMI_K31_PRO_ENABLED is exactly "true" and
 * MOONSHOT_API_KEY is set. It is not a council seat and not a chain hop.
 * MOONSHOT_API_KEY is read only when a call is actually made. Nothing in
 * the repo sets it, and this module does not read a user API key.
 *
 * K3.1 Pro always thinks. `reasoning_effort` is `low` | `high` | `max`
 * (API default `max`). Mike's `medium` maps to `high` because Moonshot
 * has no medium. Omitted effort sends no field. Stream `reasoning_content`
 * is a reasoning delta, never answer text.
 */

import type {
  NormalizedToolCall,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import { kimiMaxCompletionTokens, kimiReasoningEffort } from "./effort";
import { buildKimiChatBody } from "./requestParams";

export const DEFAULT_MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
/** China OpenAI-compatible host. Documented only; Mike does not call it. */
export const MOONSHOT_CN_BASE_URL = "https://api.moonshot.cn/v1";

/** Mike's public pin. Same string as the verified Moonshot model id. */
export const KIMI_K31_PRO_PUBLIC_ID = "kimi-k3.1-pro";
/**
 * Verified on platform.kimi.ai quickstart, model list, and K3.1 Pro guide,
 * and on the China quickstart at platform.kimi.com. Not invented.
 */
export const KIMI_K31_PRO_PROVIDER_ID = "kimi-k3.1-pro";

/** Published context window for the K3 series, including K3.1 Pro. */
export const KIMI_K31_PRO_CONTEXT_TOKENS = 1_048_576;
/** Published ceiling for max_completion_tokens. The API default is 131072. */
export const KIMI_K31_PRO_MAX_COMPLETION_TOKENS = 1_048_576;

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
      reasoning_content?: string;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatDelta = {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
};

type ChatChunk = {
  id?: string;
  model?: string;
  choices?: {
    delta?: ChatDelta;
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string | null;
  }[];
};

/** Maps Mike's public alias onto the verified provider id. */
export function moonshotProviderModelId(model: string): string {
  const id = model.trim().toLowerCase();
  if (id === KIMI_K31_PRO_PUBLIC_ID) return KIMI_K31_PRO_PROVIDER_ID;
  throw new Error(`Unknown Moonshot model id: ${model}`);
}

export function moonshotApiKey(): string {
  const key = process.env.MOONSHOT_API_KEY?.trim() || "";
  if (!key) {
    throw new Error(
      "Kimi K3.1 Pro pin kimi-k3.1-pro requires MOONSHOT_API_KEY. No Moonshot API key is configured, so the pin is rejected and does not fall back to another model.",
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

function noteReportedModel(chunk: ChatChunk, current: string): string {
  const reported = chunk.model?.trim();
  return reported || current;
}

export async function streamMoonshot(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const { tools = [], callbacks = {}, runTools } = params;
  const maxIter = params.maxIterations ?? 10;
  const client = moonshotClient();
  const model = moonshotProviderModelId(params.model);
  const reasoningEffort = kimiReasoningEffort(params.effort);
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
  let reportedModel = model;

  for (let iter = 0; iter < maxIter; iter++) {
    throwIfAborted(params.abortSignal);
    const response = await postChat({
      client,
      signal: params.abortSignal,
      body: buildKimiChatBody({
        model,
        messages,
        stream: true,
        maxTokens: kimiMaxCompletionTokens(params.effort),
        reasoningEffort,
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
    let iterReasoning = "";
    let reasoningClosed = false;

    const closeReasoning = () => {
      if (!iterReasoning || reasoningClosed) return;
      callbacks.onReasoningBlockEnd?.();
      reasoningClosed = true;
    };

    while (true) {
      throwIfAborted(params.abortSignal);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = extractSseEvents(buffer);
      buffer = parsed.rest;
      for (const chunk of parsed.events) {
        if (chunk.id) responseId = chunk.id;
        reportedModel = noteReportedModel(chunk, reportedModel);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          iterReasoning += delta.reasoning_content;
          callbacks.onReasoningDelta?.(delta.reasoning_content);
        }
        if (typeof delta.content === "string" && delta.content) {
          closeReasoning();
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
    closeReasoning();

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
      ...(iterReasoning ? { reasoning_content: iterReasoning } : {}),
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
      model_name: reportedModel,
      ...(responseId ? { provider_response_id: responseId } : {}),
    },
  };
}

export async function completeMoonshotText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  effort?: StreamChatParams["effort"];
}): Promise<string> {
  const client = moonshotClient();
  const model = moonshotProviderModelId(params.model);
  const messages: ChatMessage[] = [];
  if (params.systemPrompt) {
    messages.push({ role: "system", content: params.systemPrompt });
  }
  messages.push({ role: "user", content: params.user });
  const response = await postChat({
    client,
    body: buildKimiChatBody({
      model,
      messages,
      stream: true,
      maxTokens: kimiMaxCompletionTokens(params.effort, params.maxTokens ?? 512),
      reasoningEffort: kimiReasoningEffort(params.effort),
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
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string") text += delta.content;
    }
  }
  return text;
}
