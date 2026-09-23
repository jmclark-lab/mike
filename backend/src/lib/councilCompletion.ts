/**
 * Council completion-path guards.
 *
 * Connector jobs were completing with the chat model's intake preamble
 * ("I'll convene the five-seat Council…") as the terminal `answer` because:
 *   1. that preamble is streamed as `content_delta`
 *   2. the judge synthesis lived only in the `convene_council` tool result
 *   3. a stop/abort before the relay turn marked the job `done`
 *
 * These helpers detect a requested council, classify what landed in `answer`,
 * and emit structured completion logs.
 */

export type CouncilAnswerSource =
  | "preamble"
  | "synthesis"
  | "quorum_failure"
  | "unknown";

const SYNTHESIS_HEADER =
  /\[Council:\s*(?:mandatory\s+)?\d+\/\d+\s+opinions received/i;
const QUORUM_FAILURE =
  /Council deliberation failed and no council opinion was produced/i;

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text ?? "", "utf8");
}

export function promptRequestsCouncil(text: string): boolean {
  if (!text) return false;
  return (
    /\bconvene_council\b/i.test(text) ||
    /\bmin[_\s-]?quorum\b/i.test(text) ||
    /\bconvene(?:\s+the)?\s+(?:(?:five|four|5|4)[- ]seat\s+)?council\b/i.test(
      text,
    ) ||
    /\b(?:(?:five|four|5|4)[- ]seat)\s+council\b/i.test(text) ||
    /\blegal council\b/i.test(text)
  );
}

export function isCouncilSynthesis(text: string): boolean {
  if (!text) return false;
  return SYNTHESIS_HEADER.test(text) || QUORUM_FAILURE.test(text);
}

export function looksLikeCouncilPreamble(text: string): boolean {
  if (!text || isCouncilSynthesis(text)) return false;
  const trimmed = text.trim();
  if (trimmed.length > 2500) return false;
  return (
    /\bi(?:['’]ll| will) convene\b/i.test(trimmed) ||
    /\bsetting quorum\b/i.test(trimmed) ||
    (/\bcouncil\b/i.test(trimmed) &&
      /\bquorum\b/i.test(trimmed) &&
      !SYNTHESIS_HEADER.test(trimmed))
  );
}

export function classifyAnswerSource(text: string): CouncilAnswerSource {
  if (QUORUM_FAILURE.test(text ?? "")) return "quorum_failure";
  if (SYNTHESIS_HEADER.test(text ?? "")) return "synthesis";
  if (looksLikeCouncilPreamble(text)) return "preamble";
  return "unknown";
}

/** Drop a leading intake preamble so the stored answer starts at synthesis. */
export function preferCouncilSynthesis(text: string): string {
  if (!text || !isCouncilSynthesis(text)) return text;
  const headerIdx = text.search(SYNTHESIS_HEADER);
  const failIdx = text.search(QUORUM_FAILURE);
  const starts = [headerIdx, failIdx].filter((idx) => idx >= 0);
  if (!starts.length) return text;
  return text.slice(Math.min(...starts)).trimStart();
}

export function parseMinQuorumFromPrompt(text: string): number | undefined {
  if (!text) return undefined;
  const match =
    text.match(/\bmin[_\s-]?quorum\s*[:=]?\s*([1-5])\b/i) ||
    text.match(/\bquorum\s+(?:at|of|to)\s+([1-5])\b/i);
  if (!match) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function extractCouncilQuestion(prompt: string): string {
  const trimmed = (prompt ?? "").trim();
  if (!trimmed) {
    return "Deliberate the user's legal/regulatory request using the provided evidence.";
  }
  if (trimmed.length <= 4000) return trimmed;
  return trimmed.slice(0, 4000);
}

/**
 * Prefer the original user evidence pack when the model omitted or truncated
 * `convene_council.context` (copying an 85k-char PTA into the tool call is
 * what burns the first-turn token budget and skips the tool entirely).
 */
export function resolveCouncilContext(
  toolContext: string,
  userPrompt: string,
): string {
  const ctx = (toolContext ?? "").trim();
  const prompt = (userPrompt ?? "").trim();
  if (!prompt) return ctx;
  if (!ctx) return prompt;
  if (prompt.length > ctx.length * 2 && prompt.length > 4000) return prompt;
  return ctx;
}

export function councilSynthesisMissingError(): Error {
  return new Error(
    "council synthesis missing; refusing to complete with intake preamble",
  );
}

export function logCouncilCompletion(payload: {
  site: string;
  source: CouncilAnswerSource;
  answer_bytes: number;
  answer_snapshot: string;
  [key: string]: unknown;
}): void {
  const snapshot = String(payload.answer_snapshot ?? "").slice(0, 240);
  console.log(
    "[council.completion] " +
      JSON.stringify({
        event: "council_completion",
        ...payload,
        answer_snapshot: snapshot,
      }),
  );
}
