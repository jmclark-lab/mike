/**
 * Per-model request bodies.
 *
 * Adapters must send the object returned here and must not re-add sampling,
 * thinking-budget, prefill, or explicit-cache fields afterwards. Tests assert
 * the forbidden keys are absent from that object.
 */

export const GEMINI_4_ARGON = "gemini-4-argon";
/** Non-streaming REST cap, and the minimum cap Google tells callers to set. */
export const GEMINI_4_ARGON_MIN_OUTPUT_TOKENS = 32_768;
/** One streaming response cap. Still above the 32K floor. */
export const GEMINI_4_ARGON_STREAM_OUTPUT_TOKENS = 65_536;
/** generateContent migration note: at least 20 minutes per call. */
export const GEMINI_4_ARGON_TIMEOUT_MS = 20 * 60 * 1000;

const CLAUDE_SAMPLING_REJECT_MODELS = new Set([
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

const GEMINI_FORBIDDEN_KEYS = [
  "temperature",
  "topP",
  "top_p",
  "topK",
  "top_k",
  "candidateCount",
  "candidate_count",
  "cachedContent",
  "cached_content",
] as const;

export function geminiClientTimeoutMs(model: string): number | undefined {
  return model === GEMINI_4_ARGON ? GEMINI_4_ARGON_TIMEOUT_MS : undefined;
}

type GeminiThinkingConfig = {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: "low" | "medium" | "high";
};

/**
 * Gemini generateContent config. Gemini 4 Argon drops sampling params and
 * explicit cache handles, replaces thinking_budget with thinking_level, and
 * never sends a max output below 32,768.
 */
export function buildGeminiRequestConfig(params: {
  model: string;
  streaming: boolean;
  systemInstruction?: string;
  tools?: unknown;
  enableThinking?: boolean;
  /**
   * Chat streaming already sends a thinking config. One-shot completion
   * does not, except for Gemini 4 Argon, which must not send thinking_budget.
   */
  applyThinkingConfig?: boolean;
  maxTokens?: number;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const thinkingConfig: GeminiThinkingConfig = params.enableThinking
    ? { includeThoughts: true }
    : { thinkingBudget: 0 };

  const config: Record<string, unknown> = {
    ...(params.systemInstruction
      ? { systemInstruction: params.systemInstruction }
      : {}),
    ...(params.tools ? { tools: params.tools } : {}),
    ...(params.applyThinkingConfig ? { thinkingConfig } : {}),
    ...(params.extra ?? {}),
  };

  if (params.model !== GEMINI_4_ARGON) return config;

  for (const key of GEMINI_FORBIDDEN_KEYS) delete config[key];

  const thinking: GeminiThinkingConfig = {
    ...((config.thinkingConfig as GeminiThinkingConfig | undefined) ?? {}),
  };
  delete thinking.thinkingBudget;
  if (params.enableThinking) {
    thinking.includeThoughts = true;
    thinking.thinkingLevel = thinking.thinkingLevel ?? "medium";
  } else {
    delete thinking.includeThoughts;
    thinking.thinkingLevel = "low";
  }
  config.thinkingConfig = thinking;

  const cap = params.streaming
    ? GEMINI_4_ARGON_STREAM_OUTPUT_TOKENS
    : GEMINI_4_ARGON_MIN_OUTPUT_TOKENS;
  const requested = params.maxTokens ?? cap;
  config.maxOutputTokens = Math.min(
    Math.max(requested, GEMINI_4_ARGON_MIN_OUTPUT_TOKENS),
    cap,
  );
  return config;
}

export type ClaudeMessage = { role: string; content: unknown };

/**
 * Messages API body. Sonnet 5.5 and Haiku 5.5 return 400 for temperature,
 * top_p, top_k, thinking budgets, and a trailing assistant prefill.
 */
export function buildClaudeMessageParams<T extends ClaudeMessage>(input: {
  model: string;
  max_tokens: number;
  system?: string;
  messages: T[];
  tools?: unknown;
  enableThinking?: boolean;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: Record<string, unknown>;
}): Record<string, unknown> {
  const thinking = input.enableThinking
    ? { type: "adaptive", ...(input.thinking ?? {}) }
    : input.thinking;
  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.max_tokens,
    ...(input.system !== undefined ? { system: input.system } : {}),
    messages: input.messages,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(thinking ? { thinking } : {}),
    ...(input.enableThinking ? { output_config: { effort: "high" } } : {}),
  };
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.top_p !== undefined) body.top_p = input.top_p;
  if (input.top_k !== undefined) body.top_k = input.top_k;
  return sanitizeClaudeMessageParams(input.model, body);
}

export function sanitizeClaudeMessageParams(
  model: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!CLAUDE_SAMPLING_REJECT_MODELS.has(model)) return body;
  const next: Record<string, unknown> = { ...body };
  delete next.temperature;
  delete next.top_p;
  delete next.top_k;
  delete next.budget_tokens;

  if (next.thinking && typeof next.thinking === "object") {
    const thinking = {
      ...(next.thinking as Record<string, unknown>),
    };
    delete thinking.budget_tokens;
    if (thinking.type === "enabled") {
      delete next.thinking;
    } else {
      next.thinking = thinking;
    }
  }

  if (Array.isArray(next.messages)) {
    const messages = [...(next.messages as ClaudeMessage[])];
    while (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
      messages.pop();
    }
    next.messages = messages;
  }
  return next;
}

export function openAIPersistedReasoningContext(
  model: string,
): "all_turns" | undefined {
  if (
    model.startsWith("gpt-5.6") ||
    model === "gpt-6-astra" ||
    model === "gpt-6-sol" ||
    model === "gpt-6.1-sol"
  ) {
    return "all_turns";
  }
  return undefined;
}

/**
 * Responses API body. GPT-6.1 Sol does not accept reasoning effort `none`
 * (use `low`) or `minimal`, and sampling / logprob fields 400 while reasoning
 * is on. GPT-6 Sol keeps its existing body, including `none`.
 */
export function buildOpenAIResponsesBody(params: {
  model: string;
  instructions?: string;
  input: unknown;
  tools?: unknown[];
  stream?: boolean;
  maxTokens: number;
  previousResponseId?: string;
  reasoningSummary?: boolean;
  reasoningEffort?: string;
  reasoningContext?: "auto" | "current_turn" | "all_turns";
  temperature?: number;
  top_p?: number;
  top_logprobs?: number;
  logprobs?: boolean;
  include?: string[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    instructions: params.instructions || undefined,
    input: params.input,
    tools: params.tools?.length ? params.tools : undefined,
    stream: params.stream,
    max_output_tokens: params.maxTokens,
    previous_response_id: params.previousResponseId,
    reasoning:
      params.reasoningSummary || params.reasoningEffort || params.reasoningContext
        ? {
            ...(params.reasoningSummary ? { summary: "auto" } : {}),
            ...(params.reasoningEffort ? { effort: params.reasoningEffort } : {}),
            ...(params.reasoningContext ? { context: params.reasoningContext } : {}),
          }
        : undefined,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.top_p !== undefined) body.top_p = params.top_p;
  if (params.top_logprobs !== undefined) body.top_logprobs = params.top_logprobs;
  if (params.logprobs !== undefined) body.logprobs = params.logprobs;
  if (params.include) body.include = params.include;
  return sanitizeOpenAIResponsesBody(params.model, body);
}

export function sanitizeOpenAIResponsesBody(
  model: string,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (model !== "gpt-6.1-sol") return body;
  const next: Record<string, unknown> = { ...body };
  delete next.temperature;
  delete next.top_p;
  delete next.top_logprobs;
  delete next.logprobs;
  if (Array.isArray(next.include)) {
    const include = (next.include as unknown[]).filter(
      (item) => item !== "message.output_text.logprobs",
    );
    if (include.length) next.include = include;
    else delete next.include;
  }
  if (next.reasoning && typeof next.reasoning === "object") {
    const reasoning = { ...(next.reasoning as Record<string, unknown>) };
    if (reasoning.effort === "none" || reasoning.effort === "minimal") {
      reasoning.effort = "low";
    }
    next.reasoning = reasoning;
  }
  return next;
}
