/**
 * Model "council" for Mike Legal AI.
 *
 * Four named, provider-diverse seats must each return an independent opinion
 * before the neutral judge is allowed to reconcile them. A partial council is
 * never a council: failed seats are retried using the same model, and an
 * incomplete quorum throws a structured error instead of producing a degraded
 * single-model answer.
 */
import { completeTextStrict } from "./index";
import type { ReasoningEffort, UserApiKeys } from "./types";

export interface CouncilSeat {
  provider: "anthropic" | "sakana" | "openai" | "google";
  model: string;
  label: string;
  reasoningEffort?: ReasoningEffort;
  maxTokens: number;
}

const DEFAULT_COUNCIL_SEATS: readonly CouncilSeat[] = [
  {
    provider: "anthropic",
    model: "claude-fable-5",
    label: "Fable 5",
    maxTokens: 4000,
  },
  {
    provider: "sakana",
    model: "fugu-ultra-20260615",
    label: "Fugu Ultra",
    maxTokens: 4000,
  },
  {
    provider: "openai",
    model: "gpt-5.6-sol",
    label: "GPT-5.6 Sol Ultra",
    reasoningEffort: "xhigh",
    // OpenAI reasoning tokens count against max_output_tokens. Xhigh needs a
    // materially larger budget or the response can end before emitting text.
    maxTokens: 12000,
  },
  {
    provider: "google",
    model: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    maxTokens: 4000,
  },
] as const;

export const COUNCIL_JUDGE = "claude-opus-4-8";
export const COUNCIL_MEMBERS = DEFAULT_COUNCIL_SEATS.map((seat) => seat.model);

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

  constructor(members: CouncilMemberResult[]) {
    const failed = members
      .filter((member) => !member.ok)
      .map((member) => `${member.label}: ${member.error ?? "no answer"}`)
      .join("; ");
    const respondedCount = members.filter((member) => member.ok).length;
    super(
      `Council quorum incomplete: ${respondedCount}/${members.length} required opinions received after retries. Missing: ${failed}`,
    );
    this.name = "CouncilQuorumError";
    this.members = members;
    this.respondedCount = respondedCount;
    this.requiredCount = members.length;
  }
}

const MEMBER_SYSTEM =
  "You are one member of a legal AI council for bioaccess® (IMH Assets Corp), a Latin-American clinical-research and regulatory/market-access CRO. Answer the matter rigorously, independently, and concisely, as a careful legal/regulatory analyst would. Prefer the provided CONTEXT as authoritative; use general legal/regulatory knowledge only to fill gaps and flag where you are relying on it. State your degree of confidence and call out any assumptions. Do NOT fabricate contract terms, dates, citations, or facts that are not in the context. This is analysis for internal review, not legal advice.";

const JUDGE_SYSTEM =
  "You are the presiding judge of a legal AI council for bioaccess®. Exactly four independent models answered the SAME matter over the SAME context. Reconcile all four answers into one authoritative council opinion. You MUST: (1) give the single best final answer; (2) briefly note the points on which the members AGREED; (3) explicitly flag any DISAGREEMENTS, contradictions, or points raised by only one member — these are the items a human should review, so never paper over them; (4) if the members conflict on a material legal/regulatory point, say so plainly and explain the safer position. Do not introduce facts or contract terms that none of the members provided. Keep it tight and decision-useful. This is analysis for internal review, not legal advice.";

function intFromEnv(name: string, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function resolveCouncilSeats(
  env: NodeJS.ProcessEnv = process.env,
): CouncilSeat[] {
  return [
    {
      ...DEFAULT_COUNCIL_SEATS[0],
      model:
        env.COUNCIL_ANTHROPIC_MODEL?.trim() || DEFAULT_COUNCIL_SEATS[0].model,
    },
    {
      ...DEFAULT_COUNCIL_SEATS[1],
      model: env.COUNCIL_SAKANA_MODEL?.trim() || DEFAULT_COUNCIL_SEATS[1].model,
    },
    {
      ...DEFAULT_COUNCIL_SEATS[2],
      model: env.COUNCIL_OPENAI_MODEL?.trim() || DEFAULT_COUNCIL_SEATS[2].model,
      reasoningEffort: "xhigh",
    },
    {
      ...DEFAULT_COUNCIL_SEATS[3],
      model: env.COUNCIL_GEMINI_MODEL?.trim() || DEFAULT_COUNCIL_SEATS[3].model,
      label: env.COUNCIL_GEMINI_LABEL?.trim() || DEFAULT_COUNCIL_SEATS[3].label,
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
      logCouncil({
        phase: "member",
        ok: true,
        model: params.seat.model,
        label: params.seat.label,
        attempts: attempt,
      });
      return {
        model: params.seat.model,
        label: params.seat.label,
        answer: answer.trim(),
        ok: true,
        attempts: attempt,
      };
    } catch (error) {
      lastError = errorMessage(error);
      logCouncil({
        phase: "member_attempt",
        ok: false,
        model: params.seat.model,
        label: params.seat.label,
        attempt,
        max_attempts: params.maxAttempts,
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
}): Promise<CouncilResult> {
  return conveneCouncilWithCompleter(params, completeTextStrict);
}

export async function conveneCouncilWithCompleter(
  params: {
    question: string;
    context?: string | null;
    apiKeys?: UserApiKeys;
    onProgress?: (msg: string) => void;
  },
  complete: CouncilCompleter,
  options: CouncilRuntimeOptions = {},
): Promise<CouncilResult> {
  const { question, context, apiKeys, onProgress } = params;
  const seats = options.seats ?? resolveCouncilSeats();
  const maxAttempts =
    options.maxAttempts ?? intFromEnv("COUNCIL_MEMBER_MAX_ATTEMPTS", 3, 1, 5);
  const retryBaseDelayMs =
    options.retryBaseDelayMs ??
    intFromEnv("COUNCIL_RETRY_BASE_DELAY_MS", 1500, 0, 30000);
  const sleepFn = options.sleepFn ?? sleep;

  if (seats.length !== 4) {
    throw new Error(
      `Council configuration invalid: exactly 4 seats are required, got ${seats.length}.`,
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
    `convening mandatory 4/4 council: ${seats.map((seat) => seat.label).join(", ")}`,
  );

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

  if (respondedCount !== seats.length) {
    logCouncil({
      phase: "quorum",
      ok: false,
      responded_count: respondedCount,
      required_count: seats.length,
      members: members.map(({ model, ok, attempts, error }) => ({
        model,
        ok,
        attempts,
        error,
      })),
    });
    throw new CouncilQuorumError(members);
  }

  onProgress?.(`4/4 opinions received; reconciling via ${COUNCIL_JUDGE}`);
  const judgeSeat: CouncilSeat = {
    provider: "anthropic",
    model: COUNCIL_JUDGE,
    label: "Opus 4.8 judge",
    maxTokens: 5000,
  };
  const judgeUser =
    `MATTER:\n${question}\n\n` +
    members
      .map(
        (member, index) =>
          `=== COUNCIL MEMBER ${index + 1} — ${member.label} (${member.model}) ===\n${member.answer}`,
      )
      .join("\n\n") +
    "\n\nProduce the reconciled council opinion now. You must account for all four opinions.";

  const judge = await obtainRequiredAnswer({
    seat: judgeSeat,
    systemPrompt: JUDGE_SYSTEM,
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

  const header = `[Council: mandatory 4/4 opinions received (${members.map((member) => member.label).join(", ")}); reconciled by Opus 4.8]`;
  logCouncil({
    phase: "completed",
    ok: true,
    responded_count: respondedCount,
    required_count: seats.length,
    members: members.map(({ model, attempts }) => ({ model, attempts })),
    judge_attempts: judge.attempts,
  });
  return {
    finalAnswer: `${header}\n\n${judge.answer}`,
    members,
    respondedCount,
  };
}
