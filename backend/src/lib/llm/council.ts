/**
 * Model "council" for Mike Legal AI.
 *
 * Four named, provider-diverse seats always fan out. Sakana / Fugu is not a
 * seat. Failed seats are retried using the same model (never substituted).
 * The judge runs only after `respondedCount >= minQuorum` (env
 * `COUNCIL_MIN_QUORUM`, default 4, clamp 1–4). Below that, a structured
 * `CouncilQuorumError` is thrown and the judge is never invoked. Partial
 * successful opinions are preserved on that error. Opus 5.5 is judge only.
 */
import { completeTextStrict } from "./index";
import type { ReasoningEffort, UserApiKeys } from "./types";
import { OUTBOUND_ATTRIBUTION_RULE } from "../outboundAttribution";

export interface CouncilSeat {
  provider: "anthropic" | "openai" | "google" | "xai";
  model: string;
  label: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens: number;
}

const DEFAULT_COUNCIL_SEATS: readonly CouncilSeat[] = [
  {
    provider: "anthropic",
    model: "claude-fable-5-1",
    label: "Fable 5.1",
    maxTokens: 32000,
  },
  {
    provider: "openai",
    model: "gpt-6-astra",
    label: "GPT-6 Astra",
    reasoningEffort: "xhigh",
    // OpenAI reasoning tokens count against max_output_tokens. Xhigh needs a
    // materially larger budget or the response can end before emitting text.
    maxTokens: 16384,
  },
  {
    provider: "google",
    model: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    maxTokens: 6000,
  },
  {
    provider: "xai",
    model: "grok-4.7",
    label: "Grok 4.7",
    maxTokens: 8000,
  },
] as const;

export const COUNCIL_SEAT_COUNT = DEFAULT_COUNCIL_SEATS.length;
export const COUNCIL_JUDGE = "claude-opus-5-5";
export const COUNCIL_MEMBERS = DEFAULT_COUNCIL_SEATS.map((seat) => seat.model);

export function resolveCouncilJudge(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.COUNCIL_JUDGE?.trim() || COUNCIL_JUDGE;
}

export function resolveCouncilMinQuorum(
  override?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (override !== undefined && override !== null && override !== "") {
    const parsed =
      typeof override === "number"
        ? override
        : Number.parseInt(String(override), 10);
    if (Number.isFinite(parsed)) {
      return Math.min(COUNCIL_SEAT_COUNT, Math.max(1, Math.trunc(parsed)));
    }
  }
  return intFromRecord(env, "COUNCIL_MIN_QUORUM", COUNCIL_SEAT_COUNT, 1, COUNCIL_SEAT_COUNT);
}

export interface CouncilMemberResult {
  model: string;
  label: string;
  answer: string;
  ok: boolean;
  attempts: number;
  error?: string;
}

export interface CouncilResult {
  finalAnswer: string;
  members: CouncilMemberResult[];
  respondedCount: number;
}

export class CouncilQuorumError extends Error {
  readonly code = "COUNCIL_QUORUM_INCOMPLETE";
  readonly members: CouncilMemberResult[];
  readonly respondedCount: number;
  readonly requiredCount: number;

  constructor(members: CouncilMemberResult[], requiredCount = members.length) {
    const failed = members
      .filter((member) => !member.ok)
      .map((member) => `${member.label}: ${member.error ?? "no answer"}`)
      .join("; ");
    const respondedCount = members.filter((member) => member.ok).length;
    super(
      `Council quorum incomplete: ${respondedCount}/${requiredCount} required opinions received after retries. Missing: ${failed}`,
    );
    this.name = "CouncilQuorumError";
    this.members = members;
    this.respondedCount = respondedCount;
    this.requiredCount = requiredCount;
  }
}

export const COUNCIL_PARTIAL_ANSWER_LIMIT = 8000;

export function formatCouncilQuorumFailure(error: CouncilQuorumError): string {
  const successful = error.members.filter((member) => member.ok);
  const failed = error.members.filter((member) => !member.ok);
  const parts: string[] = [
    `Council deliberation failed and no council opinion was produced — ${error.message}.`,
    "All four named seats were convened without model substitution. Successful opinions are preserved below so they are not discarded.",
  ];
  if (successful.length) {
    parts.push("Successful member opinions:");
    for (const member of successful) {
      const truncated =
        member.answer.length > COUNCIL_PARTIAL_ANSWER_LIMIT
          ? `${member.answer.slice(0, COUNCIL_PARTIAL_ANSWER_LIMIT)}\n…[truncated]`
          : member.answer;
      parts.push(`=== ${member.label} (${member.model}) ===\n${truncated}`);
    }
  } else {
    parts.push("Successful member opinions: none.");
  }
  parts.push(
    "Failed seats:\n" +
      (failed.length
        ? failed
            .map(
              (member) =>
                `- ${member.label} (${member.model}): ${member.error ?? "no answer"}`,
            )
            .join("\n")
        : "- none"),
  );
  parts.push(
    "Retry the council after the unavailable provider/model recovers, or lower min_quorum if a partial council is acceptable.",
  );
  return parts.join("\n\n");
}

const MEMBER_SYSTEM =
  "You are one member of a legal AI council for bioaccess® (IMH Assets Corp), a Latin-American clinical-research and regulatory/market-access CRO. Answer the matter rigorously, independently, and concisely, as a careful legal/regulatory analyst would. Prefer the provided CONTEXT as authoritative; use general legal/regulatory knowledge only to fill gaps and flag where you are relying on it. State your degree of confidence and call out any assumptions. Do NOT fabricate contract terms, dates, citations, or facts that are not in the context. This is analysis for internal review, not legal advice.\n\n" +
  OUTBOUND_ATTRIBUTION_RULE;

const JUDGE_SYSTEM =
  "You are the presiding judge of a legal AI council for bioaccess®. Exactly four independent models answered the SAME matter over the SAME context. Reconcile all four answers into one authoritative council opinion. You MUST: (1) give the single best final answer; (2) briefly note the points on which the members AGREED; (3) explicitly flag any DISAGREEMENTS, contradictions, or points raised by only one member — these are the items a human should review, so never paper over them; (4) if the members conflict on a material legal/regulatory point, say so plainly and explain the safer position. Do not introduce facts or contract terms that none of the members provided. Keep it tight and decision-useful. This is analysis for internal review, not legal advice.\n\n" +
  OUTBOUND_ATTRIBUTION_RULE;

function judgeSystemPrompt(failed: CouncilMemberResult[]): string {
  if (failed.length === 0) return JUDGE_SYSTEM;
  const failedList = failed
    .map((member) => `${member.label} (${member.model})`)
    .join(", ");
  return (
    "You are the presiding judge of a legal AI council for bioaccess®. " +
    "Some named seats FAILED and returned no opinion. Reconcile ONLY the successful independent answers into one authoritative council opinion. " +
    `Failed seats (do not invent opinions for them): ${failedList}. ` +
    "You MUST: (1) give the single best final answer from the successful opinions; " +
    "(2) briefly note the points on which the successful members AGREED; " +
    "(3) explicitly flag any DISAGREEMENTS, contradictions, or points raised by only one member — these are the items a human should review, so never paper over them; " +
    "(4) if the members conflict on a material legal/regulatory point, say so plainly and explain the safer position. " +
    "Do not introduce facts or contract terms that none of the successful members provided. " +
    "Do not fabricate a missing seat's view. Keep it tight and decision-useful. This is analysis for internal review, not legal advice.\n\n" +
      OUTBOUND_ATTRIBUTION_RULE
  );
}

function buildJudgeUser(
  question: string,
  members: CouncilMemberResult[],
): string {
  const successful = members.filter((member) => member.ok);
  const failed = members.filter((member) => !member.ok);
  const failedBlock =
    failed.length === 0
      ? ""
      : "FAILED SEATS (no opinion — do not invent one):\n" +
        failed
          .map(
            (member) =>
              `- ${member.label} (${member.model}): ${member.error ?? "no answer"}`,
          )
          .join("\n") +
        "\n\n";
  const opinionBlock = successful
    .map(
      (member, index) =>
        `=== COUNCIL MEMBER ${index + 1} — ${member.label} (${member.model}) ===\n${member.answer}`,
    )
    .join("\n\n");
  const closer =
    failed.length === 0
      ? "Produce the reconciled council opinion now. You must account for all four opinions."
      : `Produce the reconciled council opinion now. Reconcile only the ${successful.length} successful opinion(s). Do not invent views for failed seats.`;
  return `MATTER:\n${question}\n\n${failedBlock}${opinionBlock}\n\n${closer}`;
}

function councilHeader(members: CouncilMemberResult[]): string {
  const successful = members.filter((member) => member.ok);
  const failed = members.filter((member) => !member.ok);
  if (failed.length === 0) {
    return `[Council: mandatory ${COUNCIL_SEAT_COUNT}/${COUNCIL_SEAT_COUNT} opinions received (${members.map((member) => member.label).join(", ")}); reconciled by Opus 5.5]`;
  }
  return `[Council: ${successful.length}/${COUNCIL_SEAT_COUNT} opinions received (${successful.map((member) => member.label).join(", ")}); failed: ${failed.map((member) => member.label).join(", ")}; reconciled by Opus 5.5]`;
}

function intFromRecord(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function intFromEnv(name: string, fallback: number, min: number, max: number) {
  return intFromRecord(process.env, name, fallback, min, max);
}

export function resolveCouncilSeats(
  env: NodeJS.ProcessEnv = process.env,
): CouncilSeat[] {
  return [
    {
      ...DEFAULT_COUNCIL_SEATS[0],
      model:
        env.COUNCIL_ANTHROPIC_MODEL?.trim() || DEFAULT_COUNCIL_SEATS[0].model,
      maxTokens: intFromRecord(
        env,
        "COUNCIL_ANTHROPIC_MAX_TOKENS",
        DEFAULT_COUNCIL_SEATS[0].maxTokens,
        1000,
        64000,
      ),
    },
    {
      ...DEFAULT_COUNCIL_SEATS[1],
      model: env.COUNCIL_OPENAI_MODEL?.trim() || DEFAULT_COUNCIL_SEATS[1].model,
      reasoningEffort: "xhigh",
      maxTokens: intFromRecord(
        env,
        "COUNCIL_OPENAI_MAX_TOKENS",
        DEFAULT_COUNCIL_SEATS[1].maxTokens,
        1000,
        64000,
      ),
    },
    {
      ...DEFAULT_COUNCIL_SEATS[2],
      model: env.COUNCIL_GEMINI_MODEL?.trim() || DEFAULT_COUNCIL_SEATS[2].model,
      label: env.COUNCIL_GEMINI_LABEL?.trim() || DEFAULT_COUNCIL_SEATS[2].label,
      maxTokens: intFromRecord(
        env,
        "COUNCIL_GEMINI_MAX_TOKENS",
        DEFAULT_COUNCIL_SEATS[2].maxTokens,
        1000,
        64000,
      ),
    },
    {
      ...DEFAULT_COUNCIL_SEATS[3],
      model: env.COUNCIL_XAI_MODEL?.trim() || DEFAULT_COUNCIL_SEATS[3].model,
      maxTokens: intFromRecord(
        env,
        "COUNCIL_XAI_MAX_TOKENS",
        DEFAULT_COUNCIL_SEATS[3].maxTokens,
        1000,
        64000,
      ),
    },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCouncil(payload: Record<string, unknown>): void {
  console.log(
    "[council.telemetry] " + JSON.stringify({ event: "council", ...payload }),
  );
}

type CouncilCompleter = typeof completeTextStrict;

interface CouncilRuntimeOptions {
  seats?: CouncilSeat[];
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

async function obtainRequiredAnswer(params: {
  seat: CouncilSeat;
  systemPrompt: string;
  user: string;
  maxTokens: number;
  apiKeys?: UserApiKeys;
  complete: CouncilCompleter;
  maxAttempts: number;
  retryBaseDelayMs: number;
  sleepFn: (ms: number) => Promise<void>;
  onProgress?: (msg: string) => void;
}): Promise<CouncilMemberResult> {
  let lastError = "no answer";
  for (let attempt = 1; attempt <= params.maxAttempts; attempt++) {
    try {
      params.onProgress?.(
        `${params.seat.label}: attempt ${attempt}/${params.maxAttempts}`,
      );
      const answer = await params.complete({
        model: params.seat.model,
        systemPrompt: params.systemPrompt,
        user: params.user,
        maxTokens: params.maxTokens,
        apiKeys: params.apiKeys,
        reasoningEffort: params.seat.reasoningEffort,
      });
      if (!answer?.trim()) throw new Error("empty response");
      const trimmed = answer.trim();
      logCouncil({
        phase: "member",
        site: "obtainRequiredAnswer",
        ok: true,
        seat_id: params.seat.model,
        model: params.seat.model,
        label: params.seat.label,
        attempts: attempt,
        returned_at: new Date().toISOString(),
        answer_chars: trimmed.length,
        answer_bytes: Buffer.byteLength(trimmed, "utf8"),
        error: null,
      });
      return {
        model: params.seat.model,
        label: params.seat.label,
        answer: trimmed,
        ok: true,
        attempts: attempt,
      };
    } catch (error) {
      lastError = errorMessage(error);
      logCouncil({
        phase: "member_attempt",
        site: "obtainRequiredAnswer",
        ok: false,
        seat_id: params.seat.model,
        model: params.seat.model,
        label: params.seat.label,
        attempt,
        max_attempts: params.maxAttempts,
        returned_at: new Date().toISOString(),
        answer_chars: 0,
        answer_bytes: 0,
        error: lastError,
      });
      if (attempt < params.maxAttempts) {
        const delay = params.retryBaseDelayMs * 2 ** (attempt - 1);
        await params.sleepFn(delay);
      }
    }
  }

  return {
    model: params.seat.model,
    label: params.seat.label,
    answer: "",
    ok: false,
    attempts: params.maxAttempts,
    error: lastError,
  };
}

export async function conveneCouncil(params: {
  question: string;
  context?: string | null;
  apiKeys?: UserApiKeys;
  onProgress?: (msg: string) => void;
  minQuorum?: number;
}): Promise<CouncilResult> {
  return conveneCouncilWithCompleter(params, completeTextStrict);
}

export async function conveneCouncilWithCompleter(
  params: {
    question: string;
    context?: string | null;
    apiKeys?: UserApiKeys;
    onProgress?: (msg: string) => void;
    minQuorum?: number;
  },
  complete: CouncilCompleter,
  options: CouncilRuntimeOptions = {},
): Promise<CouncilResult> {
  const { question, context, apiKeys, onProgress } = params;
  const seats = options.seats ?? resolveCouncilSeats();
  const minQuorum = resolveCouncilMinQuorum(params.minQuorum);
  const maxAttempts =
    options.maxAttempts ?? intFromEnv("COUNCIL_MEMBER_MAX_ATTEMPTS", 3, 1, 5);
  const retryBaseDelayMs =
    options.retryBaseDelayMs ??
    intFromEnv("COUNCIL_RETRY_BASE_DELAY_MS", 1500, 0, 30000);
  const sleepFn = options.sleepFn ?? sleep;

  if (seats.length !== COUNCIL_SEAT_COUNT) {
    throw new Error(
      `Council configuration invalid: exactly ${COUNCIL_SEAT_COUNT} seats are required, got ${seats.length}.`,
    );
  }
  const uniqueModels = new Set(seats.map((seat) => seat.model));
  if (uniqueModels.size !== seats.length) {
    throw new Error(
      "Council configuration invalid: every seat must use a distinct model.",
    );
  }

  const userBlock =
    `MATTER TO DELIBERATE:\n${question}\n\n` +
    (context && context.trim()
      ? `CONTEXT (authoritative — prefer this over prior/general knowledge):\n${context}`
      : "(No additional context was supplied. Answer from general legal/regulatory knowledge and clearly flag that no source material was provided.)");

  onProgress?.(
    `convening ${COUNCIL_SEAT_COUNT}-seat council (min quorum ${minQuorum}/${COUNCIL_SEAT_COUNT}): ${seats.map((seat) => seat.label).join(", ")}`,
  );

  const dispatchedAt = new Date().toISOString();
  logCouncil({
    phase: "dispatch",
    site: "conveneCouncilWithCompleter",
    dispatched_at: dispatchedAt,
    min_quorum: minQuorum,
    seat_ids: seats.map((seat) => seat.model),
    seats: seats.map((seat) => ({
      seat_id: seat.model,
      label: seat.label,
      dispatched_at: dispatchedAt,
    })),
  });

  const members = await Promise.all(
    seats.map((seat) =>
      obtainRequiredAnswer({
        seat,
        systemPrompt: MEMBER_SYSTEM,
        user: userBlock,
        maxTokens: seat.maxTokens,
        apiKeys,
        complete,
        maxAttempts,
        retryBaseDelayMs,
        sleepFn,
        onProgress,
      }),
    ),
  );
  const respondedCount = members.filter((member) => member.ok).length;
  const failedMembers = members.filter((member) => !member.ok);

  if (respondedCount < minQuorum) {
    logCouncil({
      phase: "quorum",
      site: "conveneCouncilWithCompleter.quorum",
      ok: false,
      source: "quorum_failure",
      responded_count: respondedCount,
      required_count: minQuorum,
      seat_count: seats.length,
      members: members.map(({ model, ok, attempts, error, answer }) => ({
        seat_id: model,
        model,
        ok,
        attempts,
        answer_chars: answer.length,
        answer_bytes: Buffer.byteLength(answer, "utf8"),
        error: error ?? null,
      })),
    });
    throw new CouncilQuorumError(members, minQuorum);
  }

  const judgeModel = resolveCouncilJudge();
  onProgress?.(
    `${respondedCount}/${COUNCIL_SEAT_COUNT} opinions received; reconciling via ${judgeModel}`,
  );
  const judgeSeat: CouncilSeat = {
    provider: "anthropic",
    model: judgeModel,
    label: "Opus 5.5 judge",
    maxTokens: intFromEnv("COUNCIL_JUDGE_MAX_TOKENS", 16000, 1000, 64000),
  };
  const judgeUser = buildJudgeUser(question, members);

  const judge = await obtainRequiredAnswer({
    seat: judgeSeat,
    systemPrompt: judgeSystemPrompt(failedMembers),
    user: judgeUser,
    maxTokens: judgeSeat.maxTokens,
    apiKeys,
    complete,
    maxAttempts,
    retryBaseDelayMs,
    sleepFn,
    onProgress,
  });
  if (!judge.ok) {
    throw new Error(
      `Council judge failed after ${judge.attempts} attempts: ${judge.error ?? "no answer"}`,
    );
  }

  const header = councilHeader(members);
  const finalAnswer = `${header}\n\n${judge.answer}`;
  logCouncil({
    phase: "aggregation",
    site: "conveneCouncilWithCompleter.judge",
    ok: true,
    source: "synthesis",
    responded_count: respondedCount,
    required_count: minQuorum,
    seat_count: seats.length,
    failed_seats: failedMembers.map((member) => member.label),
    members: members.map(({ model, ok, attempts, error, answer }) => ({
      seat_id: model,
      model,
      ok,
      attempts,
      answer_chars: answer.length,
      answer_bytes: Buffer.byteLength(answer, "utf8"),
      error: error ?? null,
    })),
    judge_attempts: judge.attempts,
    answer_bytes: Buffer.byteLength(finalAnswer, "utf8"),
    answer_snapshot: finalAnswer.slice(0, 240),
  });
  logCouncil({
    phase: "completed",
    site: "conveneCouncilWithCompleter.return",
    ok: true,
    source: "synthesis",
    responded_count: respondedCount,
    required_count: minQuorum,
    seat_count: seats.length,
    failed_seats: failedMembers.map((member) => member.label),
    members: members.map(({ model, ok, attempts }) => ({
      model,
      ok,
      attempts,
    })),
    judge_attempts: judge.attempts,
    answer_bytes: Buffer.byteLength(finalAnswer, "utf8"),
    answer_snapshot: finalAnswer.slice(0, 240),
  });
  return {
    finalAnswer,
    members,
    respondedCount,
  };
}
