import { streamSakana, completeSakanaText } from "./sakana";
import { streamClaude, completeClaudeText } from "./claude";
import { DEFAULT_SAKANA_MODEL, providerForModel } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";
import {
    isSerpEnabled, needsWebSearch, buildSearchQuery, serpSearch, formatSearchContext,
} from "../serpSearch";

export * from "./types";
export * from "./models";

const DEFAULT_FABLE_MODEL = "claude-fable-5";

function resolveActiveModel(): string {
    const explicit = process.env.LLM_MODEL?.trim();
    if (explicit) return explicit;
    if (process.env.LLM_PROVIDER?.trim().toLowerCase() === "anthropic") {
        return DEFAULT_FABLE_MODEL;
    }
    return process.env.SAKANA_MODEL?.trim() || DEFAULT_SAKANA_MODEL;
}

function resolveFallbackModel(primaryModel: string): string | null {
    const explicit = process.env.LLM_FALLBACK_MODEL?.trim();
    if (explicit) return explicit;
    if (primaryModel.startsWith("claude-")) {
        return process.env.SAKANA_MODEL?.trim() || DEFAULT_SAKANA_MODEL;
    }
    return null;
}

function isRetryableError(err: unknown): boolean {
    const msg = String(err instanceof Error ? err.message : err).toLowerCase();
    return (
        msg.includes("not_found") ||
        msg.includes("overloaded") ||
        msg.includes("timeout") ||
        msg.includes("524") ||
        msg.includes("503") ||
        msg.includes("502") ||
        msg.includes("econnreset") ||
        msg.includes("econnrefused") ||
        msg.includes("service_unavailable") ||
        msg.includes("service unavailable")
    );
}

async function invokeStream(
    model: string,
    params: StreamChatParams & { systemPrompt?: string },
): Promise<StreamChatResult> {
    const provider = providerForModel(model);
    if (provider === "claude") return streamClaude({ ...params, model });
    return streamSakana({ ...params, model });
}

async function invokeComplete(
    model: string,
    params: { systemPrompt?: string; user: string; maxTokens?: number; apiKeys?: UserApiKeys },
): Promise<string> {
    const provider = providerForModel(model);
    if (provider === "claude") return completeClaudeText({ ...params, model });
    return completeSakanaText({ ...params, model });
}

export async function streamChatWithTools(params: StreamChatParams): Promise<StreamChatResult> {
    let { systemPrompt } = params;
    if (isSerpEnabled()) {
        const lastUserMsg = [...(params.messages ?? [])].reverse().find(m => m.role === "user");
        const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg?.content ?? "");
        if (userText && needsWebSearch(userText)) {
            const query = buildSearchQuery(userText);
            try {
                const searchResult = await serpSearch(query);
                const contextBlock = formatSearchContext(searchResult);
                if (contextBlock) {
                    systemPrompt = `${contextBlock}\n\n${systemPrompt ?? ""}`;
                    console.log(`[serpSearch] Injected ${searchResult.results.length} results for: "${query.slice(0, 80)}..."`);
                }
            } catch (err) {
                console.warn("[serpSearch] Context injection failed, proceeding without web context:", err);
            }
        }
    }
    const model = resolveActiveModel();
    const fallbackModel = resolveFallbackModel(model);
    console.log(`[llm] provider=${providerForModel(model)} model=${model}` + (fallbackModel ? ` fallback=${fallbackModel}` : ""));
    try {
        return await invokeStream(model, { ...params, systemPrompt });
    } catch (err) {
        if (fallbackModel && isRetryableError(err)) {
            console.warn(`[llm] Primary ${model} failed (${err instanceof Error ? err.message : String(err)}), switching to fallback ${fallbackModel}`);
            return invokeStream(fallbackModel, { ...params, systemPrompt });
        }
        throw err;
    }
}

export async function completeText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: UserApiKeys;
}): Promise<string> {
    const model = resolveActiveModel();
    const fallbackModel = resolveFallbackModel(model);
    try {
        return await invokeComplete(model, params);
    } catch (err) {
        if (fallbackModel && isRetryableError(err)) {
            console.warn(`[llm] Primary ${model} failed in completeText, switching to fallback ${fallbackModel}`);
            return invokeComplete(fallbackModel, params);
        }
        throw err;
    }
}
