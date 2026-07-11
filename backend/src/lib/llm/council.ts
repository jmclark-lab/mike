/**
 * Model "council" for Mike Legal AI — fan a matter out to three independent
 * frontier models in parallel, then have a neutral judge (Opus 4.8, which is
 * NOT a council member) reconcile them into one answer that makes agreement and
 * — critically for legal work — DISAGREEMENT explicit.
 *
 * This is deliberately single-shot per member (no per-member tool loops): the
 * caller gathers evidence once (KB passages, playbook, contract text) and passes
 * it in as `context`, so all three members reason over identical facts.
 */
import { completeText } from "./index";
import type { UserApiKeys } from "./types";

export const COUNCIL_MEMBERS = [
  "claude-fable-5",
  "fugu-ultra-20260615",
  "gpt-5.6-sol",
] as const;
export const COUNCIL_JUDGE = "claude-opus-4-8";

export interface CouncilResult {
  finalAnswer: string;
  members: { model: string; answer: string; ok: boolean }[];
  respondedCount: number;
}

const MEMBER_SYSTEM =
  "You are one member of a legal AI council for bioaccess® (IMH Assets Corp), a Latin-American clinical-research and regulatory/market-access CRO. Answer the matter rigorously, independently, and concisely, as a careful legal/regulatory analyst would. Prefer the provided CONTEXT as authoritative; use general legal/regulatory knowledge only to fill gaps and flag where you are relying on it. State your degree of confidence and call out any assumptions. Do NOT fabricate contract terms, dates, citations, or facts that are not in the context. This is analysis for internal review, not legal advice.";

const JUDGE_SYSTEM =
  "You are the presiding judge of a legal AI council for bioaccess®. Three independent models answered the SAME matter over the SAME context. Reconcile their answers into one authoritative council opinion. You MUST: (1) give the single best final answer; (2) briefly note the points on which the members AGREED; (3) explicitly flag any DISAGREEMENTS, contradictions, or points raised by only one member — these are the items a human should review, so never paper over them; (4) if the members conflict on a material legal/regulatory point, say so plainly and explain the safer position. Do not introduce facts or contract terms that none of the members provided. Keep it tight and decision-useful. This is analysis for internal review, not legal advice.";

function label(model: string): string {
  return model.replace(/^claude-/, "").replace(/^gpt-/, "gpt-");
}

export async function conveneCouncil(params: {
  question: string;
  context?: string | null;
  apiKeys?: UserApiKeys;
  onProgress?: (msg: string) => void;
}): Promise<CouncilResult> {
  const { question, context, apiKeys, onProgress } = params;
  const userBlock =
    `MATTER TO DELIBERATE:\n${question}\n\n` +
    (context && context.trim()
      ? `CONTEXT (authoritative — prefer this over prior/general knowledge):\n${context}`
      : "(No additional context was supplied. Answer from general legal/regulatory knowledge and clearly flag that no source material was provided.)");

  onProgress?.(`convening council: ${COUNCIL_MEMBERS.map(label).join(", ")}`);

  const settled = await Promise.allSettled(
    COUNCIL_MEMBERS.map((m) =>
      completeText({ model: m, systemPrompt: MEMBER_SYSTEM, user: userBlock, maxTokens: 1600, apiKeys }),
    ),
  );

  const members = settled.map((r, i) => ({
    model: COUNCIL_MEMBERS[i],
    ok: r.status === "fulfilled" && !!(r.value && r.value.trim()),
    answer:
      r.status === "fulfilled"
        ? r.value
        : `(no answer — ${((r as PromiseRejectedResult).reason as Error)?.message ?? "error"})`,
  }));
  const respondedCount = members.filter((m) => m.ok).length;

  if (respondedCount === 0) {
    return {
      finalAnswer:
        "The council could not be convened — none of the three member models returned an answer. Try again shortly, or fall back to a single-model answer.",
      members,
      respondedCount,
    };
  }

  onProgress?.(`reconciling ${respondedCount} opinions via ${label(COUNCIL_JUDGE)}`);

  const judgeUser =
    `MATTER:\n${question}\n\n` +
    members
      .map((m, i) => `=== COUNCIL MEMBER ${i + 1} — ${m.model}${m.ok ? "" : " (did not respond)"} ===\n${m.answer}`)
      .join("\n\n") +
    `\n\nProduce the reconciled council opinion now.`;

  const finalAnswer = await completeText({
    model: COUNCIL_JUDGE,
    systemPrompt: JUDGE_SYSTEM,
    user: judgeUser,
    maxTokens: 2200,
    apiKeys,
  });

  const header = `[Council: ${respondedCount}/${COUNCIL_MEMBERS.length} models responded (${COUNCIL_MEMBERS.map(label).join(", ")}); reconciled by ${label(COUNCIL_JUDGE)}]`;
  return { finalAnswer: `${header}\n\n${finalAnswer}`, members, respondedCount };
}
