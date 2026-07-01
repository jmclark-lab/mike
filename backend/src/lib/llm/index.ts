import { streamSakana, completeSakanaText } from "./sakana";
import { DEFAULT_SAKANA_MODEL } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";
import {
    isSerpEnabled,
    needsWebSearch,
    buildSearchQuery,
    serpSearch,
    formatSearchContext,
} from "../serpSearch";

export * from "./types";
export * from "./models";

/**
 * Route ALL chat completions through Sakana Fugu (fugu-ultra-20260615).
 *
 * When SERPAPI_KEY is set in Railway Variables, regulatory and country-specific
 * queries automatically receive real-time web search context injected into the
 * system prompt before Fugu processes them. This gives Fugu access to current
 * ANVISA, ANMAT, CONIS, CNEIS, and LATAM pathway information that may not be
 * in its training data.
 *
 * Pricing: $5/M input · $30/M output (Fugu Ultra, as of 2026-06-23).
 */
export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    let { systemPrompt } = params;

    // -------------------------------------------------------------------------
    // Real-time regulatory search injection (requires SERPAPI_KEY in env)
    // When a regulatory keyword is detected in the last user message, fire a
    // SerpApi search and prepend the results to the system prompt so Fugu can
    // ground its analysis in current information.
    // -------------------------------------------------------------------------
    if (isSerpEnabled()) {
        const lastUserMsg = [...(params.messages ?? [])].reverse().find(
            (m) => m.role === "user",
        );
        const userText =
            typeof lastUserMsg?.content === "string"
                ? lastUserMsg.content
                : JSON.stringify(lastUserMsg?.content ?? "");

        if (userText && needsWebSearch(userText)) {
            const query = buildSearchQuery(userText);
            try {
                const searchResult = await serpSearch(query);
                const contextBlock = formatSearchContext(searchResult);
                if (contextBlock) {
                    systemPrompt = `${contextBlock}\n\n${systemPrompt ?? ""}`;
                    console.log(
                        `[serpSearch] Injected ${searchResult.results.length} results for: "${query.slice(0, 80)}..."`,
                    );
                }
            } catch (err) {
                // Non-fatal — Fugu continues without live context
                console.warn(
                    "[serpSearch] Context injection failed, proceeding without web context:",
                    err,
                );
            }
        }
    }

    return streamSakana({
        ...params,
        systemPrompt,
        model: process.env.SAKANA_MODEL?.trim() || DEFAULT_SAKANA_MODEL,
    });
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    return completeSakanaText({
        ...params,
        model: process.env.SAKANA_MODEL?.trim() || DEFAULT_SAKANA_MODEL,
    });
}
