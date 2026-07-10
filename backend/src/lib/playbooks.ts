/**
 * Playbooks for Mike Legal AI — encoded standard negotiating positions per
 * agreement type. The review tool fetches a playbook's rules and hands them
 * to the model to flag deviations clause-by-clause.
 */
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export interface PlaybookRule {
  topic: string;
  preferred: string | null;
  acceptable_fallback: string | null;
  dealbreaker: string | null;
  severity: string;
  notes: string | null;
  position: number;
}
export interface Playbook {
  id: string;
  name: string;
  agreement_type: string | null;
  description: string | null;
  rules: PlaybookRule[];
}

export async function listPlaybooks(db: Db, ownerId: string): Promise<{ name: string; agreement_type: string | null; description: string | null }[]> {
  const { data, error } = await db
    .from("playbooks")
    .select("name, agreement_type, description")
    .eq("owner_id", ownerId)
    .order("name");
  if (error) throw new Error(`playbooks list failed: ${error.message}`);
  return (data as { name: string; agreement_type: string | null; description: string | null }[]) ?? [];
}

export async function getPlaybook(db: Db, ownerId: string, name: string): Promise<Playbook | null> {
  const { data: pb, error } = await db
    .from("playbooks")
    .select("id, name, agreement_type, description")
    .eq("owner_id", ownerId)
    .ilike("name", name)
    .maybeSingle();
  if (error) throw new Error(`playbook fetch failed: ${error.message}`);
  if (!pb) return null;
  const playbook = pb as { id: string; name: string; agreement_type: string | null; description: string | null };
  const { data: rules, error: rErr } = await db
    .from("playbook_rules")
    .select("topic, preferred, acceptable_fallback, dealbreaker, severity, notes, position")
    .eq("playbook_id", playbook.id)
    .order("position");
  if (rErr) throw new Error(`playbook_rules fetch failed: ${rErr.message}`);
  return { ...playbook, rules: (rules as PlaybookRule[]) ?? [] };
}

export function formatPlaybookForModel(pb: Playbook): string {
  const lines: string[] = [
    `PLAYBOOK: ${pb.name}${pb.agreement_type ? ` (${pb.agreement_type})` : ""}`,
  ];
  if (pb.description) lines.push(pb.description);
  lines.push("", "Standard positions (compare the document against each; flag deviations with severity):", "");
  pb.rules.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.topic} [severity: ${r.severity}]`);
    if (r.preferred) lines.push(`   Preferred: ${r.preferred}`);
    if (r.acceptable_fallback) lines.push(`   Acceptable fallback: ${r.acceptable_fallback}`);
    if (r.dealbreaker) lines.push(`   Dealbreaker: ${r.dealbreaker}`);
    if (r.notes) lines.push(`   Notes: ${r.notes}`);
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * Redline mode: same positions, but instruct the model to emit ready-to-paste
 * replacement clause language for each deviation, not just a flag.
 */
export function formatPlaybookForRedlines(pb: Playbook): string {
  const lines: string[] = [
    `PLAYBOOK (REDLINE MODE): ${pb.name}${pb.agreement_type ? ` (${pb.agreement_type})` : ""}`,
  ];
  if (pb.description) lines.push(pb.description);
  lines.push(
    "",
    "bioaccess®'s standard positions are below. Review the document under review against each and, for every clause that does not already MEET the preferred position, produce a concrete redline.",
    "",
  );
  pb.rules.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.topic} [severity: ${r.severity}]`);
    if (r.preferred) lines.push(`   Preferred: ${r.preferred}`);
    if (r.acceptable_fallback) lines.push(`   Acceptable fallback: ${r.acceptable_fallback}`);
    if (r.dealbreaker) lines.push(`   Dealbreaker: ${r.dealbreaker}`);
    if (r.notes) lines.push(`   Notes: ${r.notes}`);
    lines.push("");
  });
  lines.push(
    "OUTPUT FORMAT — for each clause needing a change, produce a redline block:",
    "  • Topic & severity (from the playbook).",
    "  • Current language: a short quote of the clause as written (or 'MISSING — clause absent').",
    "  • Assessment: MEETS / FALLBACK / DEALBREAKER / MISSING.",
    "  • Proposed redline: the exact replacement (or new) clause text, ready to paste, drafted to reach the preferred position — or the acceptable fallback if the preferred is unrealistic for this counterparty (say which).",
    "  • Rationale: one line tying it to the playbook position.",
    "Order the redlines by severity (dealbreakers first). List clauses that already MEET the standard briefly at the end so nothing is overlooked. Do not invent facts about the counterparty; where a value is unknown, use a clearly-marked placeholder like [INSERT TERM].",
  );
  return lines.join("\n");
}

/**
 * Drafting mode: hand the model bioaccess®'s preferred positions so it can
 * generate a first-draft agreement on bioaccess paper.
 */
export function formatPlaybookForDrafting(pb: Playbook): string {
  const lines: string[] = [
    `PLAYBOOK (DRAFTING MODE): ${pb.name}${pb.agreement_type ? ` (${pb.agreement_type})` : ""}`,
  ];
  if (pb.description) lines.push(pb.description);
  lines.push(
    "",
    "Draft the agreement so that EACH clause below lands on bioaccess®'s preferred position (fall back to the acceptable fallback only if the drafting parameters require it, and note where you did). Never draft anything at or past a dealbreaker.",
    "",
  );
  pb.rules.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.topic} [severity: ${r.severity}]`);
    if (r.preferred) lines.push(`   Target (preferred): ${r.preferred}`);
    if (r.acceptable_fallback) lines.push(`   Fallback: ${r.acceptable_fallback}`);
    if (r.dealbreaker) lines.push(`   Never: ${r.dealbreaker}`);
    lines.push("");
  });
  return lines.join("\n");
}
