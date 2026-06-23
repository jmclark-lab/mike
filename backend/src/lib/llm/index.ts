import { streamSakana, completeSakanaText } from "./sakana";
import { DEFAULT_SAKANA_MODEL } from "./models";
import type { StreamChatParams, StreamChatResult, UserApiKeys } from "./types";

export * from "./types";
export * from "./models";

/**
 * Route ALL chat completions through Sakana Fugu (fugu-ultra-20260615).
 *
 * This is a straight provider swap — no feature flag, no per-request model
 * routing. The model can be overridden at the environment level via
 * SAKANA_MODEL but always targets the Sakana API.
 *
 * Pricing: $5/M input · $30/M output (Fugu Ultra, as of 2026-06-23).
 */
export async function streamChatWithTools(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    return streamSakana({
        ...params,
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
