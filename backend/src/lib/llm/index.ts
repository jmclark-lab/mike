import { streamSakana, completeSakanaText } from "./sakana";
import { streamClaude, completeClaudeText } from "./claude";
import { DEFAULT_SAKANA_MODEL, providerForModel } from "./models";
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

// ---------------------------------------------------------------------------
// Active model resolution
// ---------------------------------------------------------------------------
// Priority: LLM_MODEL env var > LLM_PROVIDER=anthropic shorthand > SAKANA_MODEL > default Fugu Ultra
//
// To use Fable 5:  set LLM_MODEL=claude-fable-5 in Railway Variables
// To use Sakana:   leave LLM_MODEL unset (or set LLM_MODEL=fugu-ultra-20260615)
// ---------------------------------------------------------------------------

const DEFAULT_FABLE_MODEL = "claude-fable-5";

function resolveActiveModel(): string {
    const explicit = process.env.LLM_MODEL?.trim();
    if (explicit) return explicit;
    if (process.env.LLM_PROVIDER?.trim().toLowerCase() === "anthropic") {
        return DEFAULT_FABLE_MODEL;
    }
    return process.env.SAKANA_MODEL?.trim() || DEFAULT_SAKANA_MODEL;
}

/**
 * Route ALL chat completions through the configured LLM provider.
 *
 * Set LLM_MODEL=claude-fable-5 in Railway Variables to use Fable 5.
 * Leave LLM_MODEL unset to use Sakana Fugu Ultra (default).
 *
 * When SERPAPI_KEY is set in Railway Variables, regulatory and country-specific
 * queries automatically receive real-time web search context injected into the
 * system prompt before the LLM processes them.
 *
 * Fable 5 pricing:  $10/M input · $50/M output
 * Fugu Ultra pricing: $5/M input · $30/M output (as of 2026-06-23)
 */
export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    let { systemPrompt } = params;

    // -------------------------------------------------------------------------
    // Real-time regulatory search injection (requires SERPAPI_KEY in env)
    // When a regulatory keyword is detected in the last user message, fire a
    // SerpApi search and prepend the results to the system prompt so the LLM
    // can ground its analysis in current information.
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
                // Non-fatal — LLM continues without live context
                console.warn(
                    "[serpSearch] Context injection failed, proceeding without web context:",
                    err,
                );
            }
        }
    }

    const model = resolveActiveModel();
    const provider = providerForModel(model);

    console.log(`[llm] provider=${provider} model=${model}`);

    if (provider === "claude") {
        return streamClaude({ ...params, systemPrompt, model });
    }

    return streamSakana({
        ...params,
        systemPrompt,
        model,
    });
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const model = resolveActiveModel();
    const provider = providerForModel(model);

    if (provider === "claude") {
        return completeClaudeText({ ...params, model });
    }

    return completeSakanaText({
        ...params,
        model: process.env.SAKANA_MODEL?.trim() || DEFAULT_SAKANA_MODEL,
    });
}
