/**
 * Website audit engine for Mike (bioaccess® AI Platform).
 *
 * Powers the `audit_website` chat tool: crawls a site via Firecrawl,
 * extracts per-page and site-level signals, and returns a compact
 * structured report the model reasons over to produce a comprehensive
 * audit across eight dimensions (positioning, crawlability, SEO
 * fundamentals, AI-answer readiness, trust signals, content gaps,
 * conversion flow, technical risks).
 *
 * Requires FIRECRAWL_API_KEY in the backend environment. When absent,
 * the tool degrades gracefully and reports that auditing is not
 * configured — Mike keeps working normally.
 *
 * Scraping is provider-agnostic behind this module: only crawlSite()
 * talks to Firecrawl, so the engine can be swapped without touching the
 * extractor or the tool wiring.
 *
 * See: https://docs.firecrawl.dev/api-reference/endpoint/crawl-post
 */

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";
const DEFAULT_MAX_PAGES = 12;
const HARD_MAX_PAGES = 30;
const SUBMIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
const CRAWL_BUDGET_MS = 8 * 60_000; // 8 min ceiling; backend keepalive holds the connector open
const FETCH_TIMEOUT_MS = 12_000;
const HOMEPAGE_MARKDOWN_CHARS = 3_000;

export function firecrawlKey(): string | null {
  return process.env.FIRECRAWL_API_KEY?.trim() || null;
}

export function isWebsiteAuditEnabled(): boolean {
  return !!firecrawlKey();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawPage {
  url: string;
  statusCode: number | null;
  rawHtml: string;
  markdown: string;
  metaTitle: string | null;
  metaDescription: string | null;
}

export interface PageSignals {
  url: string;
  status: number | null;
  title: string | null;
  title_length: number;
  meta_description: string | null;
  meta_description_length: number;
  h1: string[];
  h1_count: number;
  h2_count: number;
  word_count: number;
  canonical: string | null;
  noindex: boolean;
  has_viewport: boolean;
  lang: string | null;
  hreflang: string[];
  og: { title?: string; description?: string; image?: string; type?: string };
  twitter_card: string | null;
  json_ld_types: string[];
  images_total: number;
  images_missing_alt: number;
  links_internal: number;
  links_external: number;
  insecure_links: number;
  has_form: boolean;
  has_email: boolean;
  has_phone: boolean;
  cta_texts: string[];
}

export interface SiteSignals {
  input_url: string;
  final_origin: string;
  https: boolean;
  pages_crawled: number;
  crawl_status: string;
  credits_used: number | null;
  robots_txt: { present: boolean; disallow_all: boolean; sitemaps: string[] };
  sitemap: { present: boolean; url_count: number | null };
}

export interface AuditResult {
  ok: boolean;
  message?: string;
  site?: SiteSignals;
  homepage_markdown?: string;
  pages?: PageSignals[];
}

// ---------------------------------------------------------------------------
// Firecrawl crawl client (the only Firecrawl-specific code)
// ---------------------------------------------------------------------------

interface FirecrawlDoc {
  markdown?: string;
  rawHtml?: string;
  html?: string;
  metadata?: {
    title?: string;
    description?: string;
    statusCode?: number;
    sourceURL?: string;
    url?: string;
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface CrawlOutcome {
  pages: RawPage[];
  status: string;
  creditsUsed: number | null;
}

/**
 * Crawl a site with Firecrawl (submit → poll). Returns raw pages with
 * full HTML for signal extraction. Throws on hard failures (bad key,
 * submit rejected) so the caller can surface a clear message.
 */
export async function crawlSite(
  url: string,
  maxPages: number,
  onProgress?: (msg: string) => void,
): Promise<CrawlOutcome> {
  const key = firecrawlKey();
  if (!key) throw new Error("FIRECRAWL_API_KEY not configured");
  const limit = Math.min(Math.max(1, Math.floor(maxPages)), HARD_MAX_PAGES);

  const submit = await fetchWithTimeout(
    `${FIRECRAWL_BASE}/crawl`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        limit,
        sitemap: "include",
        scrapeOptions: {
          formats: ["markdown", "rawHtml"],
          onlyMainContent: false,
          blockAds: true,
        },
      }),
    },
    SUBMIT_TIMEOUT_MS,
  );

  if (!submit.ok) {
    const body = await submit.text().catch(() => "");
    throw new Error(`Firecrawl submit failed (HTTP ${submit.status}): ${body.slice(0, 300)}`);
  }
  const submitJson = (await submit.json()) as { id?: string; success?: boolean };
  const jobId = submitJson.id;
  if (!jobId) throw new Error("Firecrawl did not return a crawl id");
  onProgress?.(`crawl started (limit ${limit})`);

  const deadline = Date.now() + CRAWL_BUDGET_MS;
  const collected: FirecrawlDoc[] = [];
  let status = "scraping";
  let creditsUsed: number | null = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let poll: Response;
    try {
      poll = await fetchWithTimeout(
        `${FIRECRAWL_BASE}/crawl/${jobId}`,
        { headers: { Authorization: `Bearer ${key}` } },
        FETCH_TIMEOUT_MS,
      );
    } catch {
      continue; // transient; keep polling until the deadline
    }
    if (!poll.ok) {
      if (poll.status === 404) throw new Error("Firecrawl crawl job not found");
      continue;
    }
    const pj = (await poll.json()) as {
      status?: string;
      completed?: number;
      total?: number;
      creditsUsed?: number;
      data?: FirecrawlDoc[];
    };
    status = pj.status ?? status;
    if (typeof pj.creditsUsed === "number") creditsUsed = pj.creditsUsed;
    if (Array.isArray(pj.data)) {
      collected.length = 0;
      collected.push(...pj.data);
    }
    onProgress?.(`crawl ${status}: ${pj.completed ?? collected.length}/${pj.total ?? "?"} pages`);
    if (status === "completed" || status === "failed" || status === "cancelled") break;
  }

  const pages: RawPage[] = collected.map((d) => {
    const md = d.metadata ?? {};
    return {
      url: md.sourceURL || md.url || "",
      statusCode: typeof md.statusCode === "number" ? md.statusCode : null,
      rawHtml: d.rawHtml || d.html || "",
      markdown: d.markdown || "",
      metaTitle: md.title ?? null,
      metaDescription: md.description ?? null,
    };
  });

  return { pages, status, creditsUsed };
}

// ---------------------------------------------------------------------------
// HTML signal extraction (regex-based; zero extra dependencies)
// ---------------------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decode(s: string): string {
  return s
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
}

/** Read a <meta> content value by name= or property= (attribute order-independent). */
function metaContent(html: string, key: string): string | null {
  const re = new RegExp(
    `<meta[^>]*(?:name|property)\\s*=\\s*["']${key}["'][^>]*>`,
    "i",
  );
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const c = tag.match(/content\s*=\s*["']([\s\S]*?)["']/i)?.[1];
  return c ? decode(c) : null;
}

function attrAll(html: string, tag: string, attr: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const v = m[0].match(new RegExp(`${attr}\\s*=\\s*["']([\\s\\S]*?)["']`, "i"))?.[1];
    if (v) out.push(decode(v));
  }
  return out;
}

function originOf(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "";
  }
}

function extractSignals(page: RawPage, siteOrigin: string): PageSignals {
  const html = page.rawHtml || "";
  const title =
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ? decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)![1])
      : null) ?? page.metaTitle;
  const metaDesc = metaContent(html, "description") ?? page.metaDescription;

  const h1s = Array.from(html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi))
    .map((m) => stripTags(m[1]))
    .filter(Boolean);
  const h2count = (html.match(/<h2\b[^>]*>/gi) || []).length;

  const canonical =
    html.match(/<link[^>]*rel\s*=\s*["']canonical["'][^>]*>/i)?.[0]
      ?.match(/href\s*=\s*["']([\s\S]*?)["']/i)?.[1] ?? null;

  const robots = (metaContent(html, "robots") || "").toLowerCase();
  const lang = html.match(/<html[^>]*\blang\s*=\s*["']([\s\S]*?)["']/i)?.[1] ?? null;

  const hreflang = Array.from(
    html.matchAll(/<link[^>]*rel\s*=\s*["']alternate["'][^>]*>/gi),
  )
    .map((m) => m[0].match(/hreflang\s*=\s*["']([\s\S]*?)["']/i)?.[1])
    .filter((v): v is string => !!v);

  const jsonLdTypes: string[] = [];
  for (const m of html.matchAll(
    /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const n of nodes) {
        const t = (n && (n["@type"] ?? n["@graph"]?.map?.((g: any) => g["@type"]))) as unknown;
        if (typeof t === "string") jsonLdTypes.push(t);
        else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") jsonLdTypes.push(x);
      }
    } catch {
      /* ignore malformed JSON-LD */
    }
  }

  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  const imgMissingAlt = imgTags.filter(
    (t) => !/\balt\s*=\s*["'][^"']+["']/i.test(t),
  ).length;

  const hrefs = attrAll(html, "a", "href");
  let internal = 0,
    external = 0,
    insecure = 0;
  for (const h of hrefs) {
    if (/^https?:\/\//i.test(h)) {
      if (originOf(h) === siteOrigin) internal++;
      else external++;
      if (/^http:\/\//i.test(h) && siteOrigin.startsWith("https")) insecure++;
    } else if (h.startsWith("/") || (!h.startsWith("#") && !h.startsWith("mailto:") && !h.startsWith("tel:"))) {
      internal++;
    }
  }

  const ctaWords = /\b(get started|sign up|signup|book|schedule|request|contact|demo|buy|subscribe|start free|talk to|get a quote|learn more|apply)\b/i;
  const ctaTexts = new Set<string>();
  for (const m of html.matchAll(/<(?:a|button)\b[^>]*>([\s\S]*?)<\/(?:a|button)>/gi)) {
    const t = stripTags(m[1]);
    if (t && t.length <= 40 && ctaWords.test(t)) ctaTexts.add(t);
    if (ctaTexts.size >= 8) break;
  }

  const wordSource = page.markdown ? page.markdown : stripTags(html);
  const wordCount = wordSource ? wordSource.split(/\s+/).filter(Boolean).length : 0;

  return {
    url: page.url,
    status: page.statusCode,
    title,
    title_length: title ? title.length : 0,
    meta_description: metaDesc,
    meta_description_length: metaDesc ? metaDesc.length : 0,
    h1: h1s.slice(0, 3),
    h1_count: h1s.length,
    h2_count: h2count,
    word_count: wordCount,
    canonical: canonical ? decode(canonical) : null,
    noindex: /noindex/.test(robots),
    has_viewport: !!metaContent(html, "viewport"),
    lang,
    hreflang: hreflang.slice(0, 10),
    og: {
      title: metaContent(html, "og:title") || undefined,
      description: metaContent(html, "og:description") || undefined,
      image: metaContent(html, "og:image") || undefined,
      type: metaContent(html, "og:type") || undefined,
    },
    twitter_card: metaContent(html, "twitter:card"),
    json_ld_types: Array.from(new Set(jsonLdTypes)).slice(0, 12),
    images_total: imgTags.length,
    images_missing_alt: imgMissingAlt,
    links_internal: internal,
    links_external: external,
    insecure_links: insecure,
    has_form: /<form\b/i.test(html),
    has_email: /mailto:/i.test(html),
    has_phone: /tel:/i.test(html),
    cta_texts: Array.from(ctaTexts),
  };
}

// ---------------------------------------------------------------------------
// Site-level fetches (robots.txt, sitemap) — direct, no Firecrawl credits
// ---------------------------------------------------------------------------

async function fetchRobots(origin: string): Promise<SiteSignals["robots_txt"]> {
  const out = { present: false, disallow_all: false, sitemaps: [] as string[] };
  try {
    const res = await fetchWithTimeout(`${origin}/robots.txt`, {}, FETCH_TIMEOUT_MS);
    if (!res.ok) return out;
    const txt = await res.text();
    out.present = true;
    for (const line of txt.split(/\r?\n/)) {
      const sm = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (sm) out.sitemaps.push(sm[1].trim());
      if (/^\s*disallow:\s*\/\s*$/i.test(line)) out.disallow_all = true;
    }
    out.sitemaps = Array.from(new Set(out.sitemaps)).slice(0, 5);
  } catch {
    /* ignore */
  }
  return out;
}

async function fetchSitemap(
  origin: string,
  fromRobots: string[],
): Promise<SiteSignals["sitemap"]> {
  const candidates = fromRobots.length ? fromRobots : [`${origin}/sitemap.xml`];
  for (const u of candidates) {
    try {
      const res = await fetchWithTimeout(u, {}, FETCH_TIMEOUT_MS);
      if (!res.ok) continue;
      const xml = await res.text();
      const locs = (xml.match(/<loc>/gi) || []).length;
      return { present: true, url_count: locs || null };
    } catch {
      /* ignore */
    }
  }
  return { present: false, url_count: null };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export async function runWebsiteAudit(
  inputUrl: string,
  maxPages: number = DEFAULT_MAX_PAGES,
  onProgress?: (msg: string) => void,
): Promise<AuditResult> {
  if (!isWebsiteAuditEnabled()) {
    return {
      ok: false,
      message:
        "Website auditing is not configured. Set FIRECRAWL_API_KEY in the backend environment to enable it.",
    };
  }

  let url: string;
  try {
    url = normalizeUrl(inputUrl);
    new URL(url); // validate
  } catch {
    return { ok: false, message: `Invalid URL: ${inputUrl}` };
  }
  const origin = originOf(url);

  let crawl: CrawlOutcome;
  try {
    crawl = await crawlSite(url, maxPages, onProgress);
  } catch (err) {
    return { ok: false, message: `Crawl failed: ${(err as Error).message}` };
  }
  if (!crawl.pages.length) {
    return {
      ok: false,
      message: `Crawl returned no pages (status: ${crawl.status}). The site may block crawlers or be unreachable.`,
      site: {
        input_url: url,
        final_origin: origin,
        https: url.startsWith("https"),
        pages_crawled: 0,
        crawl_status: crawl.status,
        credits_used: crawl.creditsUsed,
        robots_txt: await fetchRobots(origin),
        sitemap: { present: false, url_count: null },
      },
    };
  }

  const finalOrigin = originOf(crawl.pages[0].url) || origin;
  const robots = await fetchRobots(finalOrigin);
  const sitemap = await fetchSitemap(finalOrigin, robots.sitemaps);
  const pages = crawl.pages.map((p) => extractSignals(p, finalOrigin));

  const homepage =
    crawl.pages.find((p) => {
      try {
        return new URL(p.url).pathname.replace(/\/$/, "") === "";
      } catch {
        return false;
      }
    }) ?? crawl.pages[0];

  return {
    ok: true,
    site: {
      input_url: url,
      final_origin: finalOrigin,
      https: finalOrigin.startsWith("https"),
      pages_crawled: pages.length,
      crawl_status: crawl.status,
      credits_used: crawl.creditsUsed,
      robots_txt: robots,
      sitemap,
    },
    homepage_markdown: (homepage.markdown || "").slice(0, HOMEPAGE_MARKDOWN_CHARS),
    pages,
  };
}

// ---------------------------------------------------------------------------
// Formatter — the tool-result content the model reasons over
// ---------------------------------------------------------------------------

export function formatAuditForModel(result: AuditResult): string {
  if (!result.ok || !result.site || !result.pages) {
    return `WEBSITE AUDIT: unable to complete.\nReason: ${result.message ?? "unknown error"}`;
  }
  const s = result.site;
  const lines: string[] = [
    "WEBSITE AUDIT — collected signals (crawled live).",
    "Use these signals to write a comprehensive audit across the eight dimensions listed at the end. Cite concrete signals; do not invent data not present here.",
    "",
    "== SITE ==",
    `input_url: ${s.input_url}`,
    `final_origin: ${s.final_origin}`,
    `https: ${s.https}`,
    `pages_crawled: ${s.pages_crawled}`,
    `crawl_status: ${s.crawl_status}`,
    `firecrawl_credits_used: ${s.credits_used ?? "n/a"}`,
    `robots_txt: present=${s.robots_txt.present} disallow_all=${s.robots_txt.disallow_all} sitemaps=${s.robots_txt.sitemaps.length}`,
    `sitemap: present=${s.sitemap.present} url_count=${s.sitemap.url_count ?? "n/a"}`,
    "",
    "== PER-PAGE SIGNALS (JSON) ==",
    JSON.stringify(result.pages, null, 1),
    "",
    "== HOMEPAGE CONTENT EXCERPT (markdown, truncated) ==",
    result.homepage_markdown || "(none)",
    "",
    "== REQUIRED AUDIT DIMENSIONS ==",
    "Structure the audit under these headings, each with findings + prioritized recommendations:",
    "1. Positioning & messaging — clarity of value proposition (titles, H1s, OG tags, homepage copy).",
    "2. Crawlability & indexation — robots.txt, sitemap, noindex, canonicals, status codes, internal linking.",
    "3. SEO fundamentals — title/description length & uniqueness, H1 usage, image alt coverage, thin content.",
    "4. AI-answer readiness — structured data (JSON-LD types), clear headings, concise summaries, Q&A/FAQ, entity clarity.",
    "5. Trust signals — HTTPS, About/Contact/Privacy/Terms presence, Organization/Person schema, contact methods.",
    "6. Content gaps — thin or missing pages, topic coverage vs. what the business does.",
    "7. Conversion flow — CTAs, forms, contact paths, friction.",
    "8. Technical risks — non-200 statuses, insecure (http) links on https pages, missing viewport, missing/duplicate canonicals or titles.",
    "",
    "End with a prioritized action list (high/medium/low) and note any dimension where crawl coverage was too shallow to judge.",
  ];
  return lines.join("\n");
}
