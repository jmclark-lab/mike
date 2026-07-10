/**
 * Contract obligation & deadline tracking for Mike Legal AI.
 * The model extracts key dates/obligations from a contract, then persists them
 * here; list/query surfaces upcoming and overdue items. Owner-scoped.
 */
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export interface ObligationInput {
  obligation_type: string;
  description: string;
  trigger_date?: string | null; // ISO date (YYYY-MM-DD)
  notice_window?: string | null;
  recurring?: boolean;
  severity?: string;
  counterparty?: string | null;
  agreement_type?: string | null;
}

export interface SaveParams {
  db: Db;
  ownerId: string;
  items: ObligationInput[];
  sourceTitle?: string | null;
  sourceRef?: string | null;
}

export async function saveObligations(p: SaveParams): Promise<{ saved: number }> {
  const rows = (p.items ?? [])
    .filter((it) => it && it.obligation_type && it.description)
    .map((it) => ({
      owner_id: p.ownerId,
      source_title: p.sourceTitle ?? null,
      source_ref: p.sourceRef ?? null,
      agreement_type: it.agreement_type ?? null,
      counterparty: it.counterparty ?? null,
      obligation_type: it.obligation_type,
      description: it.description,
      trigger_date: it.trigger_date && /^\d{4}-\d{2}-\d{2}$/.test(it.trigger_date) ? it.trigger_date : null,
      notice_window: it.notice_window ?? null,
      recurring: it.recurring ?? false,
      severity: it.severity ?? "medium",
      status: "open",
    }));
  if (!rows.length) return { saved: 0 };
  const { error } = await p.db.from("contract_obligations").insert(rows);
  if (error) throw new Error(`saveObligations failed: ${error.message}`);
  return { saved: rows.length };
}

export interface ListParams {
  db: Db;
  ownerId: string;
  withinDays?: number | null;
  status?: string | null;
  counterparty?: string | null;
  includeUndated?: boolean;
}

export interface ObligationRow {
  id: string;
  source_title: string | null;
  agreement_type: string | null;
  counterparty: string | null;
  obligation_type: string;
  description: string;
  trigger_date: string | null;
  notice_window: string | null;
  recurring: boolean;
  severity: string;
  status: string;
}

export async function listObligations(p: ListParams): Promise<ObligationRow[]> {
  let q = p.db
    .from("contract_obligations")
    .select("id, source_title, agreement_type, counterparty, obligation_type, description, trigger_date, notice_window, recurring, severity, status")
    .eq("owner_id", p.ownerId);
  q = q.eq("status", p.status ?? "open");
  if (p.counterparty) q = q.ilike("counterparty", `%${p.counterparty}%`);
  const { data, error } = await q.order("trigger_date", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`listObligations failed: ${error.message}`);
  let rows = (data as ObligationRow[]) ?? [];
  if (typeof p.withinDays === "number" && p.withinDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + p.withinDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    rows = rows.filter((r) => {
      if (!r.trigger_date) return p.includeUndated ?? false;
      return r.trigger_date <= cutoffStr; // includes overdue (past) + upcoming within window
    });
  }
  return rows;
}

export function formatObligationsForModel(rows: ObligationRow[], withinDays?: number | null): string {
  if (!rows.length) {
    return "No tracked obligations match. (Nothing has been saved yet, or none fall in the requested window.)";
  }
  const today = new Date().toISOString().slice(0, 10);
  const header = withinDays
    ? `Tracked obligations due on/before +${withinDays} days (overdue items included), soonest first:`
    : "Tracked obligations (soonest first; undated last):";
  const lines = [header, ""];
  rows.forEach((r) => {
    const overdue = r.trigger_date && r.trigger_date < today ? " ⚠ OVERDUE" : "";
    const date = r.trigger_date ? r.trigger_date : "no date";
    const cp = r.counterparty ? ` — ${r.counterparty}` : "";
    const notice = r.notice_window ? ` (notice: ${r.notice_window})` : "";
    const rec = r.recurring ? " [recurring]" : "";
    const src = r.source_title ? `  ‹${r.source_title}›` : "";
    lines.push(
      `• [${date}${overdue}] ${r.obligation_type} [${r.severity}]${cp}: ${r.description}${notice}${rec}${src}`,
    );
  });
  return lines.join("\n");
}
