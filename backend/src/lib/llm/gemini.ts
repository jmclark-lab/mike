import { GoogleGenAI } from "@google/genai";
import {
  GEMINI_4_ARGON,
  GEMINI_4_CARBON,
  GEMINI_4_ARGON_STREAM_OUTPUT_TOKENS,
  GEMINI_4_CARBON_MAX_OUTPUT_TOKENS,
  buildGeminiRequestConfig,
  geminiClientTimeoutMs,
} from "./requestParams";
import {
  LONG_DOCUMENT_CHARS,
  LONG_DOCUMENT_TURN_INSTRUCTION,
  MAX_LONG_DOCUMENT_CONTINUATIONS,
  conversationNeedsLongOutput,
} from "./claude";
import type {
  StreamChatParams,
  StreamChatResult,
  NormalizedToolCall,
} from "./types";
import { toGeminiTools } from "./tools";
import { createRawLlmStreamRecorder, logRawLlmStream } from "./rawStreamLog";

type GeminiPart = {
  text?: string;
  // Set by Gemini when the text content is a thought summary rather than
  // final-answer prose. Requires `thinkingConfig.includeThoughts: true`.
  thought?: boolean;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: {
    id?: string;
    name: string;
    response: Record<string, unknown>;
  };
  // Gemini 3 returns a thoughtSignature on parts that contain reasoning or
  // a functionCall. It must be echoed back verbatim on the same part when
  // we replay the model's turn, or the API rejects the next call.
  thoughtSignature?: string;
};

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

function apiKey(override?: string | null): string {
  const key = override?.trim() || process.env.GEMINI_API_KEY?.trim() || "";
  if (!key) {
    throw new Error(
      "Gemini API key is not configured. Set GEMINI_API_KEY or add a user Gemini key.",
    );
  }
  return key;
}

function client(override?: string | null, model?: string): GoogleGenAI {
  const timeout = model ? geminiClientTimeoutMs(model) : undefined;
  return new GoogleGenAI({
    apiKey: apiKey(override),
    ...(timeout ? { httpOptions: { timeout } } : {}),
  });
}

function toNativeContents(
  messages: StreamChatParams["messages"],
): GeminiContent[] {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

function geminiErrorMessage(error: unknown): string {
  const parsedObject = geminiStreamFailureMessage(error);
  if (parsedObject) return parsedObject;
  if (typeof error === "string") {
    const parsed = parseGeminiErrorPayload(error);
    if (parsed) return parsed;
    return error.startsWith("Gemini error:") ? error : `Gemini error: ${error}`;
  }
  if (error instanceof Error && error.message) {
    const parsed = parseGeminiErrorPayload(error.message);
    if (parsed) return parsed;
    return error.message.startsWith("Gemini error:")
      ? error.message
      : `Gemini error: ${error.message}`;
  }
  return `Gemini error: ${String(error)}`;
}

function parseGeminiErrorPayload(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return geminiStreamFailureMessage(parsed);
  } catch {
    return null;
  }
}

function geminiStreamFailureMessage(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object") return null;
  const record = chunk as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    const nested =
      typeof err.message === "string"
        ? parseGeminiErrorPayload(err.message)
        : null;
    if (nested) return nested;
    const message =
      typeof err.message === "string" && err.message.trim()
        ? err.message.trim()
        : "Gemini stream failed.";
    const code =
      typeof err.code === "string" && err.code.trim()
        ? err.code.trim()
        : typeof err.code === "number" && Number.isFinite(err.code)
          ? String(err.code)
          : typeof err.status === "string" && err.status.trim()
            ? err.status.trim()
            : null;
    return code
      ? `Gemini error (${code}): ${message}`
      : `Gemini error: ${message}`;
  }

  const promptFeedback = record.promptFeedback;
  if (promptFeedback && typeof promptFeedback === "object") {
    const feedback = promptFeedback as Record<string, unknown>;
    const blockReason =
      typeof feedback.blockReason === "string" ? feedback.blockReason : null;
    if (blockReason) {
      const detail =
        typeof feedback.blockReasonMessage === "string" &&
        feedback.blockReasonMessage.trim()
          ? feedback.blockReasonMessage.trim()
          : "The Gemini response was blocked.";
      return `Gemini error (${blockReason}): ${detail}`;
    }
  }

  const candidates = Array.isArray(record.candidates)
    ? (record.candidates as Record<string, unknown>[])
    : [];
  const finishReason =
    typeof candidates[0]?.finishReason === "string"
      ? candidates[0].finishReason
      : null;
  const errorFinishReasons = new Set([
    "SAFETY",
    "RECITATION",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "MALFORMED_FUNCTION_CALL",
    "OTHER",
  ]);
  if (finishReason && errorFinishReasons.has(finishReason)) {
    return `Gemini error (${finishReason}): The Gemini stream ended with an error finish reason.`;
  }

  return null;
}

function abortError(): Error {
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

export const GEMINI_LONG_DOCUMENT_CONTINUATION =
  "Continue from the exact cutoff. Do not repeat earlier text and do not add another intake preamble. " +
  "Complete the final answer. If a tool is required, call it now.";

/** Carbon stays on its 32768 clamp. Other models keep their existing caps. */
export function geminiChatMaxOutputTokens(
  model: string,
  longDocument: boolean,
): number | undefined {
  if (model === GEMINI_4_CARBON) return GEMINI_4_CARBON_MAX_OUTPUT_TOKENS;
  if (longDocument && model === GEMINI_4_ARGON) {
    return GEMINI_4_ARGON_STREAM_OUTPUT_TOKENS;
  }
  return undefined;
}

function geminiContentsChars(contents: GeminiContent[]): number {
  let chars = 0;
  for (const item of contents) {
    for (const part of item.parts) {
      if (typeof part.text === "string") chars += part.text.length;
    }
  }
  return chars;
}

export function geminiTurnIsLongDocument(
  messages: Array<{ role?: string; content?: unknown }>,
  contents?: GeminiContent[],
): boolean {
  return (
    conversationNeedsLongOutput(messages) ||
    geminiContentsChars(contents ?? []) >= LONG_DOCUMENT_CHARS
  );
}

export function shouldContinueGeminiLongDocument(args: {
  longDocument: boolean;
  finishReason: string | null | undefined;
  toolCallCount: number;
  continuationsUsed: number;
  partCount: number;
}): boolean {
  return (
    args.longDocument &&
    args.finishReason === "MAX_TOKENS" &&
    args.toolCallCount === 0 &&
    args.partCount > 0 &&
    args.continuationsUsed < MAX_LONG_DOCUMENT_CONTINUATIONS
  );
}

export function geminiChatTurnFailure(
  finishReason: string | null | undefined,
  toolCallCount: number,
  maxTokens: number | undefined,
): string | null {
  if (finishReason === "MAX_TOKENS" && toolCallCount === 0) {
    return (
      `Gemini chat turn stopped with finishReason=MAX_TOKENS and no tool call ` +
      `(maxOutputTokens=${maxTokens ?? "default"}). The partial text is not a final answer.`
    );
  }
  return null;
}

function geminiChunkFinishReason(chunk: unknown): string | null {
  if (!chunk || typeof chunk !== "object") return null;
  const candidates = (chunk as { candidates?: { finishReason?: unknown }[] })
    .candidates;
  const reason = candidates?.[0]?.finishReason;
  return typeof reason === "string" ? reason : null;
}

export type GeminiStreamGenerate = (request: {
  model: string;
  contents: GeminiContent[];
  config?: Record<string, unknown>;
}) => Promise<AsyncIterable<unknown>>;

export async function streamGemini(
  params: StreamChatParams,
  deps?: { generate?: GeminiStreamGenerate },
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
  const functionDeclarations = toGeminiTools(tools);
  const longDocumentPrompt = conversationNeedsLongOutput(params.messages);
  const systemForTurn = longDocumentPrompt
    ? `${systemPrompt ?? ""}\n\n${LONG_DOCUMENT_TURN_INSTRUCTION}`.trim()
    : systemPrompt;
  const generate: GeminiStreamGenerate = deps?.generate
    ? deps.generate
    : async (request) => {
        const ai = client(apiKeys?.gemini, model);
        return ai.models.generateContentStream({
          model: request.model,
          contents: request.contents as never,
          config: request.config as never,
        });
      };

  const contents: GeminiContent[] = toNativeContents(params.messages);
  let fullText = "";
  const rawStreamRecorder = createRawLlmStreamRecorder({
    provider: "gemini",
    model,
  });

  const consume = async (iter: number): Promise<{
    textParts: string[];
    callParts: GeminiPart[];
    replayParts: GeminiPart[];
    toolCalls: NormalizedToolCall[];
    finishReason: string | null;
  }> => {
      throwIfAborted(params.abortSignal);
      const longDocument = geminiTurnIsLongDocument(params.messages, contents);
      const maxOutputTokens = geminiChatMaxOutputTokens(model, longDocument);
      let stream: AsyncIterable<unknown>;
      try {
        stream = await generate({
          model,
          contents,
          config: buildGeminiRequestConfig({
            model,
            streaming: true,
            systemInstruction: systemForTurn,
            tools: functionDeclarations.length
              ? [{ functionDeclarations } as never]
              : undefined,
            // Other Gemini models still use thinkingBudget 0 to skip
            // thinking. Gemini 4 Argon and Carbon swap that for thinkingLevel.
            // Argon uses a max output of at least 32,768. Carbon clamps it
            // to 32,768, including when a long document asks for more.
            enableThinking,
            applyThinkingConfig: true,
            ...(maxOutputTokens !== undefined
              ? { maxTokens: maxOutputTokens }
              : {}),
          }),
        });
      } catch (error) {
        throw new Error(geminiErrorMessage(error));
      }

      // Per-iteration accumulators.
      const textParts: string[] = [];
      const callParts: GeminiPart[] = [];
      const replayParts: GeminiPart[] = [];
      const toolCalls: NormalizedToolCall[] = [];
      let finishReason: string | null = null;
      let sawThinking = false;
      const iterator = stream[Symbol.asyncIterator]();
      let rejectAbort: ((reason?: unknown) => void) | null = null;
      const abortPromise = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => rejectAbort?.(abortError());
      params.abortSignal?.addEventListener("abort", onAbort, {
        once: true,
      });

      try {
        while (true) {
          throwIfAborted(params.abortSignal);
          const { value: chunk, done } = await Promise.race([
            iterator.next(),
            abortPromise,
          ]);
          if (done) break;
          logRawLlmStream({
            provider: "gemini",
            model,
            iteration: iter,
            label: "chunk",
            payload: chunk,
          });
          rawStreamRecorder?.record({
            iteration: iter,
            label: "chunk",
            payload: chunk,
          });
          const failureMessage = geminiStreamFailureMessage(chunk);
          if (failureMessage) throw new Error(failureMessage);
          const chunkFinish = geminiChunkFinishReason(chunk);
          if (chunkFinish) finishReason = chunkFinish;

          const parts =
            (chunk as { candidates?: { content?: { parts?: GeminiPart[] } }[] })
              .candidates?.[0]?.content?.parts ?? [];

          for (const part of parts) {
            if (part.text) {
              replayParts.push(part);
              if (part.thought) {
                sawThinking = true;
                callbacks.onReasoningDelta?.(part.text);
              } else {
                textParts.push(part.text);
                callbacks.onContentDelta?.(part.text);
              }
            }
            if (part.functionCall) {
              // Preserve the whole part (including thoughtSignature)
              // so it can be echoed verbatim in the replay turn.
              callParts.push(part);
              const call: NormalizedToolCall = {
                id:
                  part.functionCall.id ??
                  `${part.functionCall.name}-${toolCalls.length}`,
                name: part.functionCall.name,
                input: part.functionCall.args ?? {},
              };
              callbacks.onToolCallStart?.(call);
              toolCalls.push(call);
            }
          }
        }
      } catch (error) {
        if (params.abortSignal?.aborted) throw abortError();
        throw new Error(geminiErrorMessage(error));
      } finally {
        params.abortSignal?.removeEventListener("abort", onAbort);
        if (params.abortSignal?.aborted) {
          await iterator.return?.();
        }
      }

      if (sawThinking) callbacks.onReasoningBlockEnd?.();
      throwIfAborted(params.abortSignal);
      fullText += textParts.join("");
      return { textParts, callParts, replayParts, toolCalls, finishReason };
  };

  try {
    for (let iter = 0; iter < maxIter; iter++) {
      let continuations = 0;
      let turn = await consume(iter);
      while (
        shouldContinueGeminiLongDocument({
          longDocument: geminiTurnIsLongDocument(params.messages, contents),
          finishReason: turn.finishReason,
          toolCallCount: turn.toolCalls.length,
          continuationsUsed: continuations,
          partCount: turn.replayParts.length,
        })
      ) {
        continuations += 1;
        contents.push({
          role: "model",
          parts: turn.replayParts.length
            ? turn.replayParts
            : [{ text: turn.textParts.join("") }],
        });
        contents.push({
          role: "user",
          parts: [{ text: GEMINI_LONG_DOCUMENT_CONTINUATION }],
        });
        console.log(
          "[council.completion] " +
            JSON.stringify({
              event: "gemini_stream_continue",
              site: "streamGemini.maxTokensContinue",
              model,
              iteration: iter,
              continuation: continuations,
              max_output_tokens: geminiChatMaxOutputTokens(
                model,
                geminiTurnIsLongDocument(params.messages, contents),
              ) ?? null,
              text_chars: fullText.length,
            }),
        );
        turn = await consume(iter);
      }

      const longDocument = geminiTurnIsLongDocument(params.messages, contents);
      const turnFailure = geminiChatTurnFailure(
        turn.finishReason,
        turn.toolCalls.length,
        geminiChatMaxOutputTokens(model, longDocument),
      );
      if (turnFailure) throw new Error(turnFailure);

      if (!turn.toolCalls.length || !runTools) {
        break;
      }

      const results = await runTools(turn.toolCalls);
      throwIfAborted(params.abortSignal);

      // Append the model's turn (text + functionCall parts, in that order)
      // and the matching functionResponse turn.
      const modelParts: GeminiPart[] = [];
      if (turn.textParts.length) modelParts.push({ text: turn.textParts.join("") });
      for (const cp of turn.callParts) modelParts.push(cp);
      contents.push({ role: "model", parts: modelParts });

      contents.push({
        role: "user",
        parts: results.map((r) => {
          const match = turn.toolCalls.find((c) => c.id === r.tool_use_id);
          return {
            functionResponse: {
              ...(r.tool_use_id && !r.tool_use_id.startsWith(match?.name ?? "")
                ? { id: r.tool_use_id }
                : {}),
              name: match?.name ?? "tool",
              response: { output: r.content },
            },
          };
        }),
      });
    }

    await rawStreamRecorder?.flush("completed");
    return {
      fullText,
      providerMetadata: { provider_name: "gemini", model_name: model },
    };
  } catch (error) {
    await rawStreamRecorder?.flush("error", error);
    throw error;
  }
}

export async function completeGeminiText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
  apiKeys?: { gemini?: string | null };
}): Promise<string> {
  const ai = client(params.apiKeys?.gemini, params.model);
  let resp: Awaited<ReturnType<typeof ai.models.generateContent>>;
  try {
    const config = buildGeminiRequestConfig({
      model: params.model,
      streaming: false,
      systemInstruction: params.systemPrompt,
      maxTokens: params.maxTokens,
      applyThinkingConfig:
        params.model === GEMINI_4_ARGON || params.model === GEMINI_4_CARBON,
    });
    resp = await ai.models.generateContent({
      model: params.model,
      contents: [{ role: "user", parts: [{ text: params.user }] }],
      ...(Object.keys(config).length ? { config: config as never } : {}),
    });
  } catch (error) {
    throw new Error(geminiErrorMessage(error));
  }
  return resp.text ?? "";
}
