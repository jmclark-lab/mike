import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  StreamChatParams,
  StreamChatResult,
  NormalizedToolCall,
  NormalizedToolResult,
} from "./types";
import { toClaudeTools } from "./tools";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";
import { buildClaudeMessageParams } from "./requestParams";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string; [key: string]: unknown };

type NativeMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

/**
 * Short-ask output ceiling. Adaptive thinking and visible text share it.
 * 16k was enough for a preamble and then `stop_reason=max_tokens` with no
 * tool call. Short asks stay on this ceiling.
 */
export const DEFAULT_CLAUDE_CHAT_MAX_TOKENS = 32000;

/** Fable 5.2 / Opus 5.5 synchronous Messages API max output. */
export const FABLE_MAX_OUTPUT_TOKENS = 128000;

/**
 * Latest user message at or above this length is a pasted contract, not a
 * short ask. Clinical-trial agreements clear it; a normal question does not.
 */
export const LONG_DOCUMENT_CHARS = 20_000;

/** Extra streamed turns after a long-document `max_tokens` stop. */
export const MAX_LONG_DOCUMENT_CONTINUATIONS = 2;

/**
 * Visible-output instruction. Fable 5.2 ignores "think less" at high effort;
 * this only stops the intake preamble from occupying the answer.
 */
export const LONG_DOCUMENT_TURN_INSTRUCTION =
  "LONG DOCUMENT:\n" +
  "The user message contains a long document. Do not write an intake plan, " +
  "status preamble, or a list of what you are about to review. " +
  "If a tool is required, call it immediately. Otherwise write the final analysis. " +
  "A preamble is not an answer.";

export const CLAUDE_LONG_DOCUMENT_CONTINUATION =
  "Continue from the exact cutoff. Do not repeat earlier text and do not add another intake preamble. " +
  "Complete the final answer. If a tool is required, call it now.";

export type ClaudeMessageStream = {
  on(event: "text", handler: (delta: string) => void): void;
  on(event: "thinking", handler: (delta: string) => void): void;
  on(event: "streamEvent", handler: (event: unknown) => void): void;
  on(event: "error", handler: (error: unknown) => void): void;
  finalMessage(): Promise<{
    stop_reason?: string | null;
    content?: ContentBlock[];
  }>;
  abort(): void;
};

export type ClaudeStreamFn = (
  body: Record<string, unknown>,
) => ClaudeMessageStream;

function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (typeof record.text === "string") chars += record.text.length;
    if (typeof record.thinking === "string") chars += record.thinking.length;
    if ("content" in record) chars += contentChars(record.content);
  }
  return chars;
}

/** Characters of user text, tool results, and assistant blocks currently in the turn. */
export function claudeConversationChars(
  messages: Array<{ content?: unknown }>,
): number {
  let chars = 0;
  for (const message of messages) chars += contentChars(message.content);
  return chars;
}

export function isLongClaudeDocument(
  messages: Array<{ role?: string; content?: unknown }>,
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    if (typeof message.content !== "string") continue;
    return message.content.length >= LONG_DOCUMENT_CHARS;
  }
  return false;
}

export function conversationNeedsLongOutput(
  messages: Array<{ role?: string; content?: unknown }>,
): boolean {
  return (
    isLongClaudeDocument(messages) ||
    claudeConversationChars(messages) >= LONG_DOCUMENT_CHARS
  );
}

/**
 * Short asks honor `CLAUDE_CHAT_MAX_TOKENS` (default 32k, hard cap 128k).
 * Long documents always use the model max. Thinking tokens count against
 * `max_tokens`, and a 32k cap is exhausted by high-effort thinking plus the
 * intake text before any final answer. An explicit env value must not put
 * that cap back on a long review.
 */
export function resolveClaudeChatMaxTokens(
  env: NodeJS.ProcessEnv = process.env,
  options?: { longDocument?: boolean },
): number {
  if (options?.longDocument) return FABLE_MAX_OUTPUT_TOKENS;
  const parsed = Number.parseInt(env.CLAUDE_CHAT_MAX_TOKENS ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CLAUDE_CHAT_MAX_TOKENS;
  return Math.min(FABLE_MAX_OUTPUT_TOKENS, Math.max(1000, Math.trunc(parsed)));
}

export function shouldContinueLongDocumentTurn(args: {
  longDocument: boolean;
  stopReason: string | null | undefined;
  toolCallCount: number;
  continuationsUsed: number;
  assistantBlockCount: number;
}): boolean {
  return (
    args.longDocument &&
    args.stopReason === "max_tokens" &&
    args.toolCallCount === 0 &&
    args.assistantBlockCount > 0 &&
    args.continuationsUsed < MAX_LONG_DOCUMENT_CONTINUATIONS
  );
}

/**
 * A chat tool-loop turn that hits max_tokens with no tool_use used to `break`
 * and return the intake preamble as a successful answer. Fail that turn.
 * Long-document turns continue first (see shouldContinueLongDocumentTurn).
 * If tool_use blocks were parsed, still run them (do not drop convene_council).
 */
export function claudeChatTurnFailure(
  stopReason: string | null | undefined,
  toolCallCount: number,
  maxTokens: number,
): string | null {
  if (stopReason === "max_tokens" && toolCallCount === 0) {
    return (
      `Claude chat turn stopped with stop_reason=max_tokens and no tool_use ` +
      `(max_tokens=${maxTokens}). The intake preamble is not a final answer.`
    );
  }
  return null;
}

function apiKey(override?: string | null): string {
  const key = override?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || "";
  if (!key) {
    throw new Error(
      "Anthropic API key is not configured. Set ANTHROPIC_API_KEY or add a user Anthropic key.",
    );
  }
  return key;
}

function client(override?: string | null): Anthropic {
  const apiKeyValue = apiKey(override);
  return new Anthropic({ apiKey: apiKeyValue });
}

function toNativeMessages(
  messages: StreamChatParams["messages"],
): NativeMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

function claudeErrorMessage(error: unknown): string {
  const parsedObject = claudeStreamFailureMessage(error);
  if (parsedObject) return parsedObject;
  if (error instanceof Error && error.message) {
    const parsed = parseClaudeErrorPayload(error.message);
    if (parsed) return parsed;
    return error.message.startsWith("Claude error:")
      ? error.message
      : `Claude error: ${error.message}`;
  }
  const parsed = parseClaudeErrorPayload(String(error));
  if (parsed) return parsed;
  return `Claude error: ${String(error)}`;
}

function parseClaudeErrorPayload(value: string): string | null {
  const trimmed = value.trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) return null;
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonEnd <= jsonStart) return null;
  const payload = trimmed.slice(jsonStart, jsonEnd + 1);
  try {
    const parsed = JSON.parse(payload) as unknown;
    return claudeStreamFailureMessage(parsed);
  } catch {
    return null;
  }
}

function claudeStreamFailureMessage(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  const error = record.error;
  if (record.type !== "error" || !error || typeof error !== "object") {
    return null;
  }
  const err = error as Record<string, unknown>;
  const type =
    typeof err.type === "string" && err.type.trim() ? err.type.trim() : null;
  const message =
    typeof err.message === "string" && err.message.trim()
      ? err.message.trim()
      : "Claude stream failed.";
  return type
    ? `Claude error (${type}): ${message}`
    : `Claude error: ${message}`;
}

function abortError(): Error {
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

export async function streamClaude(
  params: StreamChatParams,
  deps?: { stream?: ClaudeStreamFn; env?: NodeJS.ProcessEnv },
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
  const claudeTools = toClaudeTools(tools);
  // Non-streaming messages.create() is rejected once a request can exceed
  // ~10 minutes. A 128k Fable turn is past that, so every chat turn,
  // including continuations, goes through messages.stream.
  const streamMessage: ClaudeStreamFn = deps?.stream
    ? deps.stream
    : (() => {
        const anthropic = client(apiKeys?.claude);
        return (body: Record<string, unknown>) =>
          anthropic.messages.stream(
            body as unknown as Anthropic.MessageCreateParams,
          ) as unknown as ClaudeMessageStream;
      })();

  const messages: NativeMessage[] = toNativeMessages(params.messages);
  const env = deps?.env ?? process.env;
  // Decided once. The system string is part of Fable's thinking prefix and
  // must not change after the first assistant turn.
  const longDocumentPrompt = isLongClaudeDocument(params.messages);
  const systemForTurn = longDocumentPrompt
    ? `${systemPrompt}\n\n${LONG_DOCUMENT_TURN_INSTRUCTION}`
    : systemPrompt;
  const maxTokensFor = () =>
    resolveClaudeChatMaxTokens(env, {
      longDocument: conversationNeedsLongOutput(messages),
    });
  let fullText = "";
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: "claude",
    model,
  });

  const consumeStream = async (
    iter: number,
  ): Promise<{
    stopReason: string | null;
    assistantBlocks: ContentBlock[];
    toolCalls: NormalizedToolCall[];
    maxTokens: number;
  }> => {
    throwIfAborted(params.abortSignal);
    const maxTokens = maxTokensFor();
    const stream = streamMessage(
      buildClaudeMessageParams({
        model,
        system: systemForTurn,
        messages: messages as Anthropic.MessageParam[],
        tools: claudeTools.length
          ? (claudeTools as unknown as Tool[])
          : undefined,
        max_tokens: maxTokens,
        // Adaptive thinking plus output_config.effort. Sonnet 5.5 and
        // Haiku 5.5 reject temperature, top_p, top_k, and budget_tokens.
        enableThinking,
      }),
    );

    let sawThinking = false;
    let streamFailureMessage: string | null = null;
    const abortStream = () => stream.abort();
    params.abortSignal?.addEventListener("abort", abortStream, {
      once: true,
    });

    stream.on("streamEvent", (event) => {
      logRawLlmStream({
        provider: "claude",
        model,
        iteration: iter,
        label: "streamEvent",
        payload: event,
      });
      rawStreamRecorder?.record({
        iteration: iter,
        label: "streamEvent",
        payload: event,
      });
      const failureMessage = claudeStreamFailureMessage(event);
      if (failureMessage) {
        streamFailureMessage = failureMessage;
        stream.abort();
      }
    });
    stream.on("error", (error) => {
      logRawLlmStream({
        provider: "claude",
        model,
        iteration: iter,
        label: "error",
        payload: error,
      });
      rawStreamRecorder?.record({
        iteration: iter,
        label: "error",
        payload: error,
      });
    });

    stream.on("text", (delta) => {
      callbacks.onContentDelta?.(delta);
    });
    if (enableThinking) {
      stream.on("thinking", (delta) => {
        sawThinking = true;
        callbacks.onReasoningDelta?.(delta);
      });
    }

    let final: Awaited<ReturnType<typeof stream.finalMessage>>;
    try {
      final = await stream.finalMessage();
    } catch (error) {
      if (params.abortSignal?.aborted) throw abortError();
      if (streamFailureMessage) throw new Error(streamFailureMessage);
      throw new Error(claudeErrorMessage(error));
    } finally {
      params.abortSignal?.removeEventListener("abort", abortStream);
    }
    if (sawThinking) callbacks.onReasoningBlockEnd?.();
    throwIfAborted(params.abortSignal);
    const stopReason = final.stop_reason ?? null;
    const assistantBlocks = Array.isArray(final.content) ? final.content : [];

    // Extract text content and tool_use calls from the final assistant
    // message so we can accumulate text and drive the tool-call loop.
    const toolCalls: NormalizedToolCall[] = [];
    for (const block of assistantBlocks) {
      if (block.type === "text") {
        const txt = (block as { text: string }).text;
        if (typeof txt === "string") fullText += txt;
      } else if (block.type === "tool_use") {
        const tu = block as {
          id: string;
          name: string;
          input: unknown;
        };
        const call: NormalizedToolCall = {
          id: tu.id,
          name: tu.name,
          input: (tu.input as Record<string, unknown>) ?? {},
        };
        callbacks.onToolCallStart?.(call);
        toolCalls.push(call);
      }
    }

    return { stopReason, assistantBlocks, toolCalls, maxTokens };
  };

  try {
    for (let iter = 0; iter < maxIter; iter++) {
      let continuations = 0;
      let turn = await consumeStream(iter);

      while (
        shouldContinueLongDocumentTurn({
          longDocument: conversationNeedsLongOutput(messages),
          stopReason: turn.stopReason,
          toolCallCount: turn.toolCalls.length,
          continuationsUsed: continuations,
          assistantBlockCount: turn.assistantBlocks.length,
        })
      ) {
        continuations += 1;
        // Replay the assistant turn unchanged, thinking blocks included.
        // Fable 5.2 rejects a rewritten prefix.
        messages.push({ role: "assistant", content: turn.assistantBlocks });
        messages.push({
          role: "user",
          content: CLAUDE_LONG_DOCUMENT_CONTINUATION,
        });
        console.log(
          "[council.completion] " +
            JSON.stringify({
              event: "claude_stream_continue",
              site: "streamClaude.maxTokensContinue",
              model,
              iteration: iter,
              continuation: continuations,
              max_tokens: turn.maxTokens,
              text_chars: fullText.length,
            }),
        );
        turn = await consumeStream(iter);
      }

      console.log(
        "[council.completion] " +
          JSON.stringify({
            event: "claude_stream_turn",
            site: "streamClaude.turnEnd",
            model,
            iteration: iter,
            stop_reason: turn.stopReason,
            continuation: continuations,
            max_tokens: turn.maxTokens,
            tool_names: turn.toolCalls.map((call) => call.name),
            text_chars: fullText.length,
          }),
      );

      const turnFailure = claudeChatTurnFailure(
        turn.stopReason,
        turn.toolCalls.length,
        turn.maxTokens,
      );
      if (turnFailure) throw new Error(turnFailure);

      // Run any parsed tool_use blocks even when stop_reason is not exactly
      // tool_use (e.g. max_tokens after a partial convene_council JSON).
      if (!turn.toolCalls.length || !runTools) {
        break;
      }

      const results = await runTools(turn.toolCalls);
      throwIfAborted(params.abortSignal);

      // Record the assistant turn (preserving the original content blocks,
      // which Claude requires on the follow-up) and the user turn that
      // carries the tool_result blocks.
      messages.push({ role: "assistant", content: turn.assistantBlocks });
      messages.push({
        role: "user",
        content: results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.tool_use_id,
          content: r.content,
        })),
      });
    }

    await rawStreamRecorder?.flush("completed");
    return { fullText };
  } catch (error) {
    await rawStreamRecorder?.flush("error", error);
    throw error;
  }
}

export async function completeClaudeText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { claude?: string | null };
}): Promise<string> {
  const anthropic = client(params.apiKeys?.claude);
  const maxTokens = params.maxTokens ?? 512;
  // Anthropic rejects non-streaming create() when the request may exceed
  // ~10 minutes (Fable council seat at COUNCIL_ANTHROPIC_MAX_TOKENS=32k).
  // Redeploy nudge 2026-09-16: ensure Railway picks up streaming completeText.
  // Stream + finalMessage() is the supported long-request path and keeps
  // the same text-block extraction / empty diagnostics as before.
  let resp: Anthropic.Message;
  try {
    const stream = anthropic.messages.stream(
      buildClaudeMessageParams({
        model: params.model,
        max_tokens: maxTokens,
        system: params.systemPrompt,
        messages: [{ role: "user", content: params.user }],
      }) as unknown as Anthropic.MessageCreateParams,
    );
    resp = await stream.finalMessage();
  } catch (error) {
    throw new Error(claudeErrorMessage(error));
  }
  const content = Array.isArray(resp.content) ? resp.content : [];
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  if (!text.trim()) {
    throw new Error(
      describeEmptyClaudeText(
        { stop_reason: resp.stop_reason, content },
        maxTokens,
      ),
    );
  }
  return text;
}

/** Diagnostic for empty Claude payloads. Never substitutes thinking-block text. */
export function describeEmptyClaudeText(
  resp: { stop_reason?: string | null; content?: Array<{ type?: string }> },
  maxTokens: number,
): string {
  const blockTypeCounts: Record<string, number> = {};
  for (const block of resp.content ?? []) {
    const type = typeof block?.type === "string" ? block.type : "unknown";
    blockTypeCounts[type] = (blockTypeCounts[type] ?? 0) + 1;
  }
  const stopReason = resp.stop_reason ?? "unknown";
  return (
    `empty Claude text (stop_reason=${stopReason}; ` +
    `block_types=${JSON.stringify(blockTypeCounts)}; ` +
    `max_tokens_hit=${stopReason === "max_tokens"}; ` +
    `max_tokens=${maxTokens})`
  );
}

// Helper re-export for callers wanting to hand normalized results back in.
export type { NormalizedToolResult };
