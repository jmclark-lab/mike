import type {
  LlmMessage,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
  StreamChatParams,
  StreamChatResult,
} from "./types";
import type { ReasoningEffort } from "./types";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_OUTPUT_TOKENS = 16384;
const COURTLISTENER_CITATION_REMINDER_TOOL_NAMES = new Set([
  "courtlistener_find_in_case",
  "courtlistener_read_case",
]);
const COURTLISTENER_CITATION_REMINDER = `COURTLISTENER CITATION REMINDER:
If your final answer relies on any CourtListener case, every such case reference must have BOTH a clickable markdown case link and an inline [N] marker.
Include the clickable case link only the first time you cite that case; later references to the same case should reuse the existing inline [N] marker without repeating the link unless clarity requires it.
Assign new refs in first-use order as much as possible: [1], then [2], then [3]. Reuse an existing ref when citing the same case/passage again, even if that means a later sentence cites [3] and then [1] again.
End the response with a <CITATIONS> block containing one matching case entry per [N] marker:
{"ref": N, "cluster_id": 123, "quotes": [{"opinion_id": 456, "quote": "exact verbatim opinion text"}]}.
Do not use doc_id, page, top-level quote, case_name, or citation fields for CourtListener case entries.`;

type ResponseInputItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call_output"; call_id: string; output: string };

type ResponseFunctionTool = {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};

type ResponseFunctionCallItem = {
  type: "function_call";
  call_id?: string;
  name?: string;
  arguments?: string;
};

type ResponseOutputItem = {
  type?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

type ResponseStreamEvent = {
  type?: string;
  delta?: string;
  response?: {
    id?: string;
    output_text?: string;
    status?: string;
    incomplete_details?: { reason?: string } | null;
    output?: ResponseOutputItem[];
    error?: { code?: string; message?: string } | null;
  };
  error?: { code?: string; message?: string } | null;
  item?: ResponseFunctionCallItem;
};

type ResponseTerminalState = {
  id?: string;
  status?: string;
  incompleteReason?: string;
  outputText?: string;
};

const STRICT_COMPLETION_MAX_CONTINUATIONS = 2;
const STRICT_COMPLETION_CONTINUATION_PROMPT =
  "Continue from the prior response and deliver the complete final opinion now. Do not repeat prior text. Include every required conclusion, recommendation, and qualification.";

function apiKey(override?: string | null): string {
  const key = override?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
  if (!key) {
    throw new Error(
      "OpenAI API key is not configured. Set OPENAI_API_KEY or add a user OpenAI key.",
    );
  }
  return key;
}

function toResponseTools(tools: OpenAIToolSchema[]): ResponseFunctionTool[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }));
}

function toResponseInput(messages: LlmMessage[]): ResponseInputItem[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function extractSseJson(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
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
        events.push(JSON.parse(data));
      } catch {
        // Incomplete events stay buffered until the next read.
      }
    }
  }

  return { events, rest };
}

function parseFunctionCall(item: ResponseFunctionCallItem): NormalizedToolCall {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(item.arguments || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    input = {};
  }

  return {
    id: item.call_id ?? item.name ?? "function_call",
    name: item.name ?? "",
    input,
  };
}

function openAIStreamFailureMessage(event: ResponseStreamEvent): string | null {
  const error = event.response?.error ?? event.error ?? null;
  const failed =
    event.type === "response.failed" ||
    event.response?.status === "failed" ||
    !!error;
  if (!failed) return null;

  const message =
    typeof error?.message === "string" && error.message.trim()
      ? error.message.trim()
      : "OpenAI response failed.";
  const code =
    typeof error?.code === "string" && error.code.trim()
      ? error.code.trim()
      : null;
  return code ? `OpenAI error (${code}): ${message}` : message;
}

function responseOutputText(output?: ResponseOutputItem[]): string {
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((content) => content?.type === "output_text")
    .map((content) => (typeof content.text === "string" ? content.text : ""))
    .join("");
}

function abortError(): Error {
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function responseInstructions(systemPrompt: string, includeReminder: boolean) {
  return includeReminder
    ? `${systemPrompt}\n\n${COURTLISTENER_CITATION_REMINDER}`
    : systemPrompt;
}

function shouldAppendCourtlistenerCitationReminder(call: NormalizedToolCall) {
  return COURTLISTENER_CITATION_REMINDER_TOOL_NAMES.has(call.name);
}

async function createResponse(params: {
  model: string;
  input: ResponseInputItem[];
  instructions?: string;
  tools?: ResponseFunctionTool[];
  stream?: boolean;
  maxTokens?: number;
  previousResponseId?: string;
  reasoningSummary?: boolean;
  reasoningEffort?: ReasoningEffort;
  reasoningContext?: "auto" | "current_turn" | "all_turns";
  apiKey: string;
  signal?: AbortSignal;
}): Promise<Response> {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: params.model,
      instructions: params.instructions || undefined,
      input: params.input,
      tools: params.tools?.length ? params.tools : undefined,
      stream: params.stream,
      max_output_tokens: params.maxTokens ?? MAX_OUTPUT_TOKENS,
      previous_response_id: params.previousResponseId,
      reasoning:
        params.reasoningSummary ||
        params.reasoningEffort ||
        params.reasoningContext
          ? {
              ...(params.reasoningSummary ? { summary: "auto" } : {}),
              ...(params.reasoningEffort
                ? { effort: params.reasoningEffort }
                : {}),
              ...(params.reasoningContext
                ? { context: params.reasoningContext }
                : {}),
            }
          : undefined,
    }),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const err = new Error(
      `OpenAI request failed (${response.status}): ${text || response.statusText}`,
    );
    (err as { status?: number }).status = response.status;
    throw err;
  }

  return response;
}

export async function streamOpenAI(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const {
    model,
    systemPrompt,
    tools = [],
    callbacks = {},
    runTools,
    apiKeys,
    enableThinking,
  } = params;
  const maxIter = params.maxIterations ?? 10;
  const key = apiKey(apiKeys?.openai);
  const responseTools = toResponseTools(tools);
  let input = toResponseInput(params.messages);
  let previousResponseId: string | undefined;
  let fullText = "";
  let needsCourtlistenerCitationReminder = false;
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: "openai",
    model,
  });

  try {
    for (let iter = 0; iter < maxIter; iter++) {
      throwIfAborted(params.abortSignal);
      const response = await createResponse({
        model,
        instructions: responseInstructions(
          systemPrompt,
          needsCourtlistenerCitationReminder,
        ),
        input,
        tools: responseTools,
        stream: true,
        previousResponseId,
        reasoningSummary: !!enableThinking,
        apiKey: key,
        signal: params.abortSignal,
      });
      if (!response.body) throw new Error("OpenAI response had no body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const toolCalls: NormalizedToolCall[] = [];
      const startedToolCallIds = new Set<string>();
      let buffer = "";
      let sawReasoning = false;

      while (true) {
        throwIfAborted(params.abortSignal);
        const { done, value } = await reader.read();
        if (done) break;

        const decoded = decoder.decode(value, { stream: true });
        logRawLlmStream({
          provider: "openai",
          model,
          iteration: iter,
          label: "sse_chunk",
          payload: decoded,
        });
        rawStreamRecorder?.record({
          iteration: iter,
          label: "sse_chunk",
          payload: decoded,
        });
        buffer += decoded;
        const extracted = extractSseJson(buffer);
        buffer = extracted.rest;

        for (const event of extracted.events as ResponseStreamEvent[]) {
          logRawLlmStream({
            provider: "openai",
            model,
            iteration: iter,
            label: "sse_event",
            payload: event,
          });
          rawStreamRecorder?.record({
            iteration: iter,
            label: "sse_event",
            payload: event,
          });

          const failureMessage = openAIStreamFailureMessage(event);
          if (failureMessage) {
            throw new Error(failureMessage);
          }

          if (event.response?.id) {
            previousResponseId = event.response.id;
          }

          if (
            event.type === "response.reasoning_summary_text.delta" &&
            typeof event.delta === "string"
          ) {
            sawReasoning = true;
            callbacks.onReasoningDelta?.(event.delta);
          }

          if (
            event.type === "response.output_text.delta" &&
            typeof event.delta === "string"
          ) {
            fullText += event.delta;
            callbacks.onContentDelta?.(event.delta);
          }

          if (
            event.type === "response.output_item.added" &&
            event.item?.type === "function_call"
          ) {
            const call = parseFunctionCall(event.item);
            startedToolCallIds.add(call.id);
            callbacks.onToolCallStart?.(call);
          }

          if (
            event.type === "response.output_item.done" &&
            event.item?.type === "function_call"
          ) {
            const call = parseFunctionCall(event.item);
            if (!startedToolCallIds.has(call.id)) {
              callbacks.onToolCallStart?.(call);
            }
            toolCalls.push(call);
          }
        }
      }

      if (sawReasoning) callbacks.onReasoningBlockEnd?.();
      throwIfAborted(params.abortSignal);

      if (!toolCalls.length || !runTools) {
        break;
      }

      if (toolCalls.some(shouldAppendCourtlistenerCitationReminder)) {
        needsCourtlistenerCitationReminder = true;
      }

      const results = await runTools(toolCalls);
      throwIfAborted(params.abortSignal);
      input = results.map((result) => ({
        type: "function_call_output",
        call_id: result.tool_use_id,
        output: result.content,
      }));
    }

    await rawStreamRecorder?.flush("completed");
    return { fullText };
  } catch (error) {
    await rawStreamRecorder?.flush("error", error);
    throw error;
  }
}

export async function completeOpenAIText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { openai?: string | null };
  reasoningEffort?: ReasoningEffort;
}): Promise<string> {
  const key = apiKey(params.apiKeys?.openai);
  let previousResponseId: string | undefined;
  let input: ResponseInputItem[] = [{ role: "user", content: params.user }];
  let fullText = "";

  for (
    let continuation = 0;
    continuation <= STRICT_COMPLETION_MAX_CONTINUATIONS;
    continuation += 1
  ) {
    const response = await createResponse({
      model: params.model,
      instructions: params.systemPrompt,
      input,
      maxTokens: params.maxTokens ?? 512,
      previousResponseId,
      reasoningEffort: params.reasoningEffort,
      reasoningContext: params.model.startsWith("gpt-5.6")
        ? "all_turns"
        : undefined,
      apiKey: key,
      // Council opinions can take longer than Railway's roughly five-minute
      // outbound time-to-first-byte ceiling. Streaming gets response headers and
      // deltas flowing immediately while this adapter still returns one complete
      // opinion to the strict council caller.
      stream: true,
    });
    if (!response.body) throw new Error("OpenAI response had no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let terminal: ResponseTerminalState = {};

    const consume = (events: unknown[]) => {
      for (const raw of events) {
        const event = raw as ResponseStreamEvent;
        const failure = openAIStreamFailureMessage(event);
        if (failure) throw new Error(failure);
        if (event.type === "response.output_text.delta" && event.delta) {
          text += event.delta;
        }
        if (
          event.type === "response.completed" ||
          event.type === "response.incomplete"
        ) {
          const fallbackText =
            typeof event.response?.output_text === "string"
              ? event.response.output_text
              : responseOutputText(event.response?.output);
          terminal = {
            id: event.response?.id,
            status: event.response?.status,
            incompleteReason: event.response?.incomplete_details?.reason,
            outputText: fallbackText,
          };
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = extractSseJson(buffer);
      buffer = parsed.rest;
      consume(parsed.events);
    }

    buffer += decoder.decode();
    if (buffer.trim()) consume(extractSseJson(`${buffer}\n\n`).events);

    const responseText = text || terminal.outputText || "";
    fullText += responseText;
    if (terminal.status !== "incomplete") {
      if (!fullText.trim()) {
        throw new Error(
          `OpenAI response completed without output text (response ${terminal.id || "unknown"}).`,
        );
      }
      return fullText;
    }

    const canContinue =
      terminal.incompleteReason === "max_output_tokens" &&
      !!terminal.id &&
      continuation < STRICT_COMPLETION_MAX_CONTINUATIONS;
    console.info(
      "[openai.telemetry]",
      JSON.stringify({
        event: "strict_completion_incomplete",
        model: params.model,
        response_id: terminal.id || null,
        reason: terminal.incompleteReason || null,
        continuation,
        will_continue: canContinue,
      }),
    );
    if (!canContinue) {
      throw new Error(
        `OpenAI response incomplete (${terminal.incompleteReason || "unknown reason"}, response ${terminal.id || "unknown"}) after ${continuation} continuation(s).`,
      );
    }

    previousResponseId = terminal.id;
    input = [{ role: "user", content: STRICT_COMPLETION_CONTINUATION_PROMPT }];
  }

  throw new Error(
    "OpenAI strict completion exhausted its continuation budget.",
  );
}

export type { NormalizedToolResult };
