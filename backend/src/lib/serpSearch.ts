/**
 * SerpApi web search integration for Mike (bioaccess® AI Platform).
 *
 * Provides real-time web search context for regulatory pathway validation,
 * device classification lookups, and LATAM country approval timelines.
 *
 * Requires SERPAPI_KEY to be set in Railway Variables. When absent, all
 * functions degrade gracefully — Mike continues to operate using only
 * Fugu Ultra's training data.
 */

const SERPAPI_BASE = "https://serpapi.com/search";
const MAX_RESULTS = 5;
const TIMEOUT_MS = 12_000;

export interface SerpResult {
    title: string;
    link: string;
    snippet: string;
    date?: string;
    source?: string;
}

export interface SerpSearchResponse {
    results: SerpResult[];
    query: string;
    timestamp: string;
}

function serpApiKey(): string | null {
    return process.env.SERPAPI_KEY?.trim() || null;
}

export function isSerpEnabled(): boolean {
    return !!serpApiKey();
}

export async function serpSearch(query: string): Promise<SerpSearchResponse> {
    const key = serpApiKey();
    const timestamp = new Date().toISOString();
    if (!key) return { results: [], query, timestamp };

    const params = new URLSearchParams({
        api_key: key,
        engine: "google",
        q: query,
        num: String(MAX_RESULTS),
        hl: "en",
        safe: "active",
    });

    try {
        const controller = new AbortController();
        const timerId = setTimeout(() => controller.abort(), TIMEOUT_MS);
        const response = await fetch(`${SERPAPI_BASE}?${params.toString()}`, {
            signal: controller.signal,
        });
        clearTimeout(timerId);

        if (!response.ok) {
            console.warn(`[serpSearch] HTTP ${response.status} for query: "${query}"`);
            return { results: [], query, timestamp };
        }

        const data = (await response.json()) as {
            organic_results?: {
                title?: string;
                link?: string;
                snippet?: string;
                date?: string;
                source?: string;
            }[];
            error?: string;
        };

        if (data.error) {
            console.warn(`[serpSearch] API error: ${data.error}`);
            return { results: [], query, timestamp };
        }

        const results: SerpResult[] = (data.organic_results ?? [])
            .slice(0, MAX_RESULTS)
            .map((r) => ({
                title: r.title ?? "",
                link: r.link ?? "",
                snippet: r.snippet ?? "",
                ...(r.date && { date: r.date }),
                ...(r.source && { source: r.source }),
            }));

        return { results, query, timestamp };
    } catch (err) {
        if ((err as { name?: string }).name === "AbortError") {
            console.warn(`[serpSearch] Timed out after ${TIMEOUT_MS}ms`);
        } else {
            console.warn("[serpSearch] Fetch error:", err);
        }
        return { results: [], query, timestamp };
    }
}

const REGULATORY_KEYWORDS: string[] = [
    "conis", "cneis", "anmat", "anvisa", "cofepris", "invima", "emed", "anamed", "cecmed",
    "regulatory", "regulatoria", "regulatorio", "pathway", "approval",
    "homologation", "registro sanitario", "registry", "clearance", "authorization",
    "timeline", "cronograma", "plazo", "business days", "working days",
    "class ii", "class iii", "clase ii", "clase iii", "510(k)", "510k", "pma", "de novo", "ide ",
    "investigational device", "dispositivo médico", "medical device",
    "pivotal trial", "pivotal study", "ensayo pivotal", "ensayo clínico", "clinical trial",
    "panama", "panamá", "chile", "argentina", "brazil", "brasil",
    "costa rica", "el salvador", "dominicana", "dominican republic",
    "colombia", "mexico", "méxico", "peru", "perú",
];

export function needsWebSearch(text: string): boolean {
    const lower = text.toLowerCase();
    return REGULATORY_KEYWORDS.some((kw) => lower.includes(kw));
}

export function buildSearchQuery(userMessage: string): string {
    const text = userMessage.trim();
    if (text.length <= 400) return text.slice(0, 350);
    const head = text.slice(0, 150).trim();
    const tail = text.slice(-200).trim();
    return `${head} ${tail}`.replace(/\s+/g, " ").trim().slice(0, 350);
}

export function formatSearchContext(response: SerpSearchResponse): string {
    if (response.results.length === 0) return "";
    const lines: string[] = [
        `[REAL-TIME WEB SEARCH — ${response.timestamp}]`,
        `Query: "${response.query}"`,
        "The following current sources were retrieved to supplement your training data:",
        "",
    ];
    for (const [i, r] of response.results.entries()) {
        const dateStr = r.date ? ` (${r.date})` : "";
        lines.push(`[${i + 1}] ${r.title}${dateStr}`);
        if (r.source) lines.push(`    Source: ${r.source}`);
        lines.push(`    ${r.snippet}`);
        lines.push(`    URL: ${r.link}`);
        lines.push("");
    }
    lines.push("[END REAL-TIME CONTEXT]", "Cross-reference these results with your training data when synthesizing.", "");
    return lines.join("\n");
}
