/**
 * Firecrawl search + scrape client for Mike's hybrid search router.
 *
 * Unlike SerpApi (titles / snippets / rankings), Firecrawl's /search discovers
 * results AND returns the full page content as clean Markdown in one request,
 * and /scrape retrieves the full content of a specific URL. All retrieved
 * content is untrusted evidence and is size-capped before injection.
 *
 * Requires FIRECRAWL_API_KEY. Docs: https://docs.firecrawl.dev/features/search
 */
const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";
const SEARCH_TIMEOUT_MS = 25_000;
const SCRAPE_TIMEOUT_MS = 20_000;
const DEFAULT_LIMIT = 5;
const MAX_SCRAPE_PAGES = 3;
const MAX_CONTENT_CHARS = 6000;

export interface FirecrawlResult {
  title: string;
  url: string;
  description: string;
  markdown?: string;
  date?: string;
}

export function firecrawlSearchKey(): string | null {
  return process.env.FIRECRAWL_API_KEY?.trim() || null;
}

export function firecrawlSearchEnabled(): boolean {
  return !!firecrawlSearchKey();
}

function safeText(value: string, max: number): string {
  return value.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeUrl(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    u.username = "";
    u.password = "";
    u.hash = "";
    return u.toString().slice(0, 1000);
  } catch {
    return "";
  }
}

// Strip control characters EXCEPT newline, so Markdown structure survives.
function safeMarkdown(value: string, max: number): string {
  return value
    .replace(/[^\P{Cc}\n]/gu, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function log(payload: Record<string, unknown>): void {
  console.log(`[firecrawl.telemetry] ${JSON.stringify({ event: "firecrawl", ...payload })}`);
}

interface FcDoc {
  url?: string;
  title?: string;
  description?: string;
  markdown?: string;
  metadata?: { title?: string; description?: string; sourceURL?: string; url?: string };
}

function normalizeDoc(d: FcDoc): FirecrawlResult | null {
  const url = safeUrl(d.url || d.metadata?.sourceURL || d.metadata?.url || "");
  if (!url) return null;
  const title = safeText(d.title || d.metadata?.title || "", 300);
  const description = safeText(d.description || d.metadata?.description || "", 1200);
  const markdown = d.markdown ? safeMarkdown(d.markdown, MAX_CONTENT_CHARS) : undefined;
  return { title, url, description, ...(markdown ? { markdown } : {}) };
}

/**
 * Firecrawl /search: discovery + optional full-content scrape in one request.
 * Returns results with title, url, description and (when scrape=true) markdown.
 */
export async function firecrawlSearch(
  query: string,
  opts?: { limit?: number; scrape?: boolean },
): Promise<FirecrawlResult[]> {
  const key = firecrawlSearchKey();
  const q = query.replace(/\s+/g, " ").trim().slice(0, 350);
  if (!key || !q) return [];
  const limit = Math.min(Math.max(1, opts?.limit ?? DEFAULT_LIMIT), 10);
  const scrape = opts?.scrape !== false;
  const startedAt = Date.now();
  const body: Record<string, unknown> = { query: q, limit };
  if (scrape) body.scrapeOptions = { formats: ["markdown"], onlyMainContent: true, blockAds: true };
  try {
    const res = await fetchWithTimeout(
      `${FIRECRAWL_BASE}/search`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      SEARCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      log({ outcome: "http_error", status: res.status, latency_ms: Date.now() - startedAt });
      return [];
    }
    const json = (await res.json()) as { success?: boolean; data?: FcDoc[] | { web?: FcDoc[] } };
    const raw = Array.isArray(json.data) ? json.data : json.data?.web ?? [];
    const results = raw.map(normalizeDoc).filter((r): r is FirecrawlResult => !!r).slice(0, limit);
    log({
      outcome: "success",
      results: results.length,
      scraped: results.filter((r) => r.markdown).length,
      latency_ms: Date.now() - startedAt,
    });
    return results;
  } catch (err) {
    log({
      outcome: (err as { name?: string }).name === "AbortError" ? "timeout" : "fetch_error",
      latency_ms: Date.now() - startedAt,
    });
    return [];
  }
}

/**
 * Firecrawl /scrape: fetch full Markdown for specific URLs (used by the hybrid
 * SerpApi-discovery -> Firecrawl-retrieval path). Concurrency- and size-capped.
 */
export async function firecrawlScrape(urls: string[]): Promise<FirecrawlResult[]> {
  const key = firecrawlSearchKey();
  if (!key) return [];
  const targets = urls.map(safeUrl).filter(Boolean).slice(0, MAX_SCRAPE_PAGES);
  if (targets.length === 0) return [];
  const startedAt = Date.now();
  const out = await Promise.all(
    targets.map(async (url) => {
      try {
        const res = await fetchWithTimeout(
          `${FIRECRAWL_BASE}/scrape`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
            body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true, blockAds: true }),
          },
          SCRAPE_TIMEOUT_MS,
        );
        if (!res.ok) return null;
        const json = (await res.json()) as { data?: FcDoc };
        return normalizeDoc({ ...(json.data ?? {}), url });
      } catch {
        return null;
      }
    }),
  );
  const results = out.filter((r): r is FirecrawlResult => !!r && !!r.markdown);
  log({ outcome: "scrape_batch", requested: targets.length, retrieved: results.length, latency_ms: Date.now() - startedAt });
  return results;
}
