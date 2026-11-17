/**
 * Optional ask_mike effort (low | medium | high | max) mapped onto the
 * request field each provider already accepts.
 *
 * Omitted effort keeps the hard defaults for the unpinned chain:
 * gemini-4-carbon thinking_level high, grok-4.7 reasoning effort xhigh
 * (the top value on the xAI Responses API). Other providers keep the
 * body they already sent when the caller does not pass effort.
 */

import type { AskEffort, ReasoningEffort } from "./types";

export const ASK_EFFORTS = ["low", "medium", "high", "max"] as const;

export const GEMINI_4_CARBON_DEFAULT_THINKING_LEVEL = "high" as const;
/** Top reasoning.effort on grok-4.7. xAI has no "max"; xhigh is the top. */
export const GROK_TOP_REASONING_EFFORT = "xhigh" as const;
/** Visible-output floor when grok-4.7 is at xhigh. Reasoning can fill a smaller cap. */
export const GROK_XHIGH_MIN_OUTPUT_TOKENS = 32_768;

const ASK_EFFORT_SET = new Set<string>(ASK_EFFORTS);

export function parseAskEffort(
  value: unknown,
): { ok: true; effort: AskEffort | undefined } | { ok: false; detail: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, effort: undefined };
  }
  if (typeof value !== "string") {
    return {
      ok: false,
      detail: "effort must be a string: low, medium, high, or max.",
    };
  }
  const key = value.trim().toLowerCase();
  if (!key) {
    return {
      ok: false,
      detail: "effort must be a non-empty string: low, medium, high, or max.",
    };
  }
  if (!ASK_EFFORT_SET.has(key)) {
    return {
      ok: false,
      detail: `Unknown effort "${value.trim()}". Allowed values: low, medium, high, max.`,
    };
  }
  return { ok: true, effort: key as AskEffort };
}

export type GeminiThinkingLevel = "low" | "medium" | "high";

/**
 * Gemini 4 Carbon and Argon accept thinking_level low | medium | high.
 * Carbon has no level above high, so max maps to high. Carbon's omitted
 * default is high. Argon keeps its existing medium default when effort
 * is omitted (returns undefined and the request builder fills medium).
 */
export function geminiThinkingLevel(
  model: string,
  effort?: AskEffort,
): GeminiThinkingLevel | undefined {
  const gemini4 = model === "gemini-4-carbon" || model === "gemini-4-argon";
  if (!gemini4) return undefined;
  if (!effort) {
    return model === "gemini-4-carbon"
      ? GEMINI_4_CARBON_DEFAULT_THINKING_LEVEL
      : undefined;
  }
  if (effort === "max") return "high";
  return effort;
}

/**
 * grok-4.7 reasoning.effort. Omitted effort is xhigh. max is xhigh.
 * Other xAI ids only send an effort when the caller set one.
 */
export function xaiReasoningEffort(
  model: string,
  effort?: AskEffort,
): ReasoningEffort | undefined {
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "max") return GROK_TOP_REASONING_EFFORT;
  if (model === "grok-4.7") return GROK_TOP_REASONING_EFFORT;
  return undefined;
}

export function xaiMaxOutputTokens(
  model: string,
  effort: ReasoningEffort | undefined,
  requested?: number,
): number {
  const base =
    requested ??
    (effort === GROK_TOP_REASONING_EFFORT
      ? GROK_XHIGH_MIN_OUTPUT_TOKENS
      : 16_384);
  if (model === "grok-4.7" && effort === GROK_TOP_REASONING_EFFORT) {
    return Math.max(base, GROK_XHIGH_MIN_OUTPUT_TOKENS);
  }
  return base;
}

/** Claude output_config.effort. max is a real Messages API value. */
export function anthropicOutputEffort(
  effort?: AskEffort,
): "low" | "medium" | "high" | "max" {
  if (!effort) return "high";
  return effort;
}

/**
 * OpenAI reasoning.effort. Omitted effort sends no effort field (today's
 * chat body). max is official on gpt-6.1-sol. Other OpenAI ids in this
 * repo top out at xhigh (Astra's council value).
 */
export function openAIReasoningEffort(
  model: string,
  effort?: AskEffort,
): ReasoningEffort | undefined {
  if (!effort) return undefined;
  if (effort === "max") return model === "gpt-6.1-sol" ? "max" : "xhigh";
  return effort;
}

export function openAIMaxOutputTokens(
  effort: AskEffort | undefined,
  requested = 16_384,
): number {
  if (effort === "high" || effort === "max") return Math.max(requested, 32_768);
  return requested;
}

/** Nemotron only has a boolean. low turns thinking off; every other value leaves it on. */
export function nvidiaEnableThinking(effort?: AskEffort): boolean {
  return effort !== "low";
}

/**
 * Kimi K3.1 Pro reasoning_effort. Moonshot accepts low, high, and max
 * (default max) and has no medium. medium maps to high. Omitted effort
 * sends no field, so the API default (max) applies. Thinking cannot be
 * turned off.
 */
export type KimiReasoningEffort = "low" | "high" | "max";

export function kimiReasoningEffort(
  effort?: AskEffort,
): KimiReasoningEffort | undefined {
  if (!effort) return undefined;
  if (effort === "low") return "low";
  if (effort === "medium" || effort === "high") return "high";
  return "max";
}

/** Reasoning tokens count against the completion cap. low keeps a smaller cap. */
export function kimiMaxCompletionTokens(
  effort?: AskEffort,
  requested?: number,
): number {
  const floor = effort === "low" ? 16_384 : 32_768;
  if (requested === undefined) return floor;
  return Math.max(1, Math.trunc(requested));
}
