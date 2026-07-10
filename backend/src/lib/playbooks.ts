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
