/**
 * SerpApi web search integration for Mike (bioaccess® AI Platform).
 *
 * Provides real-time web search context for all queries, grounding
 * Fugu Ultra's responses in current information.
 *
 * Requires SERPAPI_KEY to be set in Railway Variables. When absent, all
 * functions degrade gracefully — Mike continues to operate using only
 * Fugu Ultra's training data.
 *
 * See: https://serpapi.com/search-api
 */

const SERPAPI_BASE = "https://serpapi.com/search";
const MAX_RESULTS = 5;
const TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Core search
// ---------------------------------------------------------------------------

function serpApiKey(): string | null {
    return process.env.SERPAPI_KEY?.trim() || null;
}

export function isSerpEnabled(): boolean {
    return !!serpApiKey();
}

export async function serpSearch(query: string): Promise<SerpSearchResponse> {
    const key = serpApiKey();
    const timestamp = new Date().toISOString();

    if (!key) {
        return { results: [], query, timestamp };
    }

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
            console.warn(`[serpSearch] Timed out after ${TIMEOUT_MS}ms for: "${query}"`);
        } else {
            console.warn("[serpSearch] Fetch error:", err);
        }
        return { results: [], query, timestamp };
    }
}

// ---------------------------------------------------------------------------
// Search gate — always enabled when SERPAPI_KEY is set.
// Every query gets real-time web context injected into the system prompt.
// ---------------------------------------------------------------------------

export function needsWebSearch(_text: string): boolean {
    return true;
}

// ---------------------------------------------------------------------------
// Search query builder
// For long messages (pasted documents), extract the most query-relevant
// portion rather than sending megabytes to SerpApi.
// ---------------------------------------------------------------------------

export function buildSearchQuery(userMessage: string): string {
    const text = userMessage.trim();

    if (text.length <= 400) {
        // Short messages: use directly
        return text.slice(0, 350);
    }

    // Long messages (document pasted inline):
    // Combine context header (first 150 chars) + analysis request (last 200 chars).
    const head = text.slice(0, 150).trim();
    const tail = text.slice(-200).trim();
    return `${head} ${tail}`.replace(/\s+/g, " ").trim().slice(0, 350);
}

// ---------------------------------------------------------------------------
// Context formatter
// Produces the block injected into the system prompt before Fugu processes
// the query. Format is intentionally terse and clearly delimited so Fugu
// can distinguish it from the system instructions.
// ---------------------------------------------------------------------------

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

    lines.push(
        "[END REAL-TIME CONTEXT]",
        "Cross-reference these results with your training data when synthesizing.",
        "",
    );

    return lines.join("\n");
}
