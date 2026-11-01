export interface ModelOption {
    id: string;
    label: string;
    group: "Anthropic" | "Google" | "OpenAI" | "xAI" | "Moonshot";
}

export const MODELS: ModelOption[] = [
    { id: "claude-fable-5-1", label: "Claude Fable 5.1", group: "Anthropic" },
    { id: "claude-fable-5", label: "Claude Fable 5", group: "Anthropic" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5", group: "Anthropic" },
    { id: "claude-opus-5", label: "Claude Opus 5", group: "Anthropic" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", group: "Anthropic" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7", group: "Anthropic" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", group: "Anthropic" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", group: "Anthropic" },
    { id: "gemini-4-argon", label: "Gemini 4 Argon", group: "Google" },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", group: "Google" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", group: "Google" },
    { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", group: "Google" },
    { id: "gpt-6-astra", label: "GPT-6 Astra", group: "OpenAI" },
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", group: "OpenAI" },
    { id: "gpt-6-sol", label: "GPT-6 Sol", group: "OpenAI" },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", group: "OpenAI" },
    { id: "gpt-5.5", label: "GPT-5.5", group: "OpenAI" },
    { id: "gpt-5.4", label: "GPT-5.4", group: "OpenAI" },
    { id: "grok-4.7", label: "Grok 4.7", group: "xAI" },
    { id: "kimi-k3.1-pro", label: "Kimi K3.1 Pro", group: "Moonshot" },
];

export const SETTINGS_MODELS: ModelOption[] = [
    ...MODELS,
    { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", group: "Anthropic" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", group: "Anthropic" },
    {
        id: "gemini-3.1-flash-lite",
        label: "Gemini 3.1 Flash Lite",
        group: "Google",
    },
    { id: "gpt-5.4-lite", label: "GPT-5.4 Lite", group: "OpenAI" },
];

export const DEFAULT_MODEL_ID = "gemini-3-flash-preview";

export const ALLOWED_MODEL_IDS = new Set(MODELS.map((m) => m.id));

export function isKimiPickerModelId(id: string): boolean {
    return id.trim().toLowerCase().startsWith("kimi-");
}

/** Sakana Fugu, DeepSeek, and Kimi. Kept out of the picker while Sponsor-CI mode is on. */
export function isFencedPickerModelId(id: string): boolean {
    const normalized = id.trim().toLowerCase();
    return (
        normalized.startsWith("fugu-") ||
        normalized.startsWith("deepseek-") ||
        normalized.startsWith("kimi-")
    );
}

export function visiblePickerModels<T extends { id: string }>(
    models: readonly T[],
    sponsorCiMode: boolean,
    kimiEnabled = false,
): T[] {
    return models.filter((model) => {
        if (isKimiPickerModelId(model.id) && !kimiEnabled) return false;
        if (sponsorCiMode && isFencedPickerModelId(model.id)) return false;
        return true;
    });
}

export const GROUP_ORDER: ModelOption["group"][] = [
    "Anthropic",
    "Google",
    "OpenAI",
    "xAI",
    "Moonshot",
];
