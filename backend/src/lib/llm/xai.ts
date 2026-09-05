/**
 * xAI Grok provider adapter.
 *
 * Grok is OpenAI-compatible at https://api.x.ai/v1 (Chat Completions and
 * Responses). Mike reuses the Responses adapter with this base URL. Grok is
 * selectable in chat (not in the default fallback chain) and is the fifth
 * legal-council seat.
 */

import {
    completeOpenAIText,
    streamOpenAI,
    type OpenAICompatibleClient,
} from "./openai";
import type { ReasoningEffort, StreamChatParams, StreamChatResult } from "./types";

export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";

export function xaiApiKey(override?: string | null): string {
    const key = override?.trim() || process.env.XAI_API_KEY?.trim() || "";
    if (!key) {
        throw new Error(
            "xAI API key is not configured. Set XAI_API_KEY or add a user xAI key.",
        );
    }
    return key;
}

export function xaiBaseUrl(): string {
    return (process.env.XAI_BASE_URL?.trim() || DEFAULT_XAI_BASE_URL).replace(
        /\/$/,
        "",
    );
}

export function xaiClient(override?: string | null): OpenAICompatibleClient {
    return {
        provider: "xai",
        baseUrl: xaiBaseUrl(),
        apiKey: xaiApiKey(override),
    };
}

export async function streamXai(
    params: StreamChatParams,
): Promise<StreamChatResult> {
    const result = await streamOpenAI(params, xaiClient(params.apiKeys?.xai));
    return {
        ...result,
        providerMetadata: {
            provider_name: "xai",
            model_name: params.model,
            ...(result.providerMetadata?.provider_response_id
                ? { provider_response_id: result.providerMetadata.provider_response_id }
                : {}),
        },
    };
}

export async function completeXaiText(params: {
    model: string;
    systemPrompt?: string;
    user: string;
    maxTokens?: number;
    apiKeys?: { xai?: string | null };
    reasoningEffort?: ReasoningEffort;
}): Promise<string> {
    return completeOpenAIText(params, xaiClient(params.apiKeys?.xai));
}
