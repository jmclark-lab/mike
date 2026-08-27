/**
 * KB tenant tags for Mike.
 *
 * bioaccess® is the CRO (current playbooks / executed contracts).
 * Amavita is a separate medical practice. Lola will send Amavita
 * questions; those must not be silently answered from the CRO playbook.
 *
 * source_tag remains a document category (manual, feasibility, …).
 * tenant is the practice/org the document belongs to.
 */

export const KB_TENANTS = ["bioaccess", "amavita"] as const;
export type KbTenant = (typeof KB_TENANTS)[number];

export const DEFAULT_KB_TENANT: KbTenant = "bioaccess";

const ALIASES: Record<string, KbTenant> = {
  bioaccess: "bioaccess",
  "bioaccess®": "bioaccess",
  cro: "bioaccess",
  amavita: "amavita",
};

export function normalizeTenant(
  value: string | null | undefined,
): KbTenant | null {
  if (!value || typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/®/g, "");
  if (!key) return null;
  if (key === "bioaccess" || key === "cro") return "bioaccess";
  if (key === "amavita") return "amavita";
  return ALIASES[key] ?? null;
}

export function resolveIngestTenant(
  value: string | null | undefined,
): KbTenant {
  return normalizeTenant(value) ?? DEFAULT_KB_TENANT;
}

/** Infer tenant from a user question. Amavita wins if both are mentioned. */
export function inferTenant(text: string | null | undefined): KbTenant | null {
  if (!text) return null;
  const t = text.toLowerCase();
  if (/\bamavita\b/.test(t)) return "amavita";
  if (/\bbioaccess\b/.test(t)) return "bioaccess";
  return null;
}

export function resolveSearchTenant(opts: {
  explicit?: string | null;
  query?: string | null;
}): KbTenant | null {
  return normalizeTenant(opts.explicit) ?? inferTenant(opts.query);
}

export function tenantLabel(tenant: KbTenant | string | null | undefined): string {
  if (tenant === "amavita") return "Amavita (medical practice)";
  if (tenant === "bioaccess") return "bioaccess® (CRO)";
  return "unknown tenant";
}
