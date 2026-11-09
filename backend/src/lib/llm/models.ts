import type { Provider } from "./types";
import { isSponsorCiFencedModel } from "../sponsorCiMode";

// ---------------------------------------------------------------------------
// Canonical model IDs
// ---------------------------------------------------------------------------
// Main-chat tier (top-end) — user picks one of these per message.
export const CLAUDE_MAIN_MODELS = [
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-sonnet-5-5",
    "claude-sonnet-4-6",
] as const;
export const GEMINI_MAIN_MODELS = [
    "gemini-4-argon",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
] as const;
export const OPENAI_MAIN_MODELS = [
    "gpt-6-astra",
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-5.6-sol",
    "gpt-5.5",
    "gpt-5.4",
] as const;
// Retired Sakana ids. Kept so the unused adapter tests can name them.
// Excluded from ALL_MODELS so settings and resolveModel cannot select them.
export const FUGU_MAIN_MODELS = [
    "fugu-ultra-20260615",
    "fugu-20260615",
] as const;
export const GROK_MAIN_MODELS = ["grok-4.7"] as const;
// Official OpenAI-compat ids as of 2026-09-05 (V4 Flash + V4 Pro).
export const DEEPSEEK_MAIN_MODELS = [
    "deepseek-v4-flash",
    "deepseek-v4-pro",
] as const;
// Moonshot OpenAI-compatible id. Selectable only while KIMI_K31_PRO_ENABLED
// is on. Not a council seat. No API key is wired in this repo.
export const MOONSHOT_MAIN_MODELS = ["kimi-k3.1-pro"] as const;

// Default Sakana Fugu model.
export const DEFAULT_SAKANA_MODEL = "fugu-ultra-20260615";

// Mid-tier (used for tabular review) — user picks one in account settings.
export const CLAUDE_MID_MODELS = ["claude-sonnet-5-5"] as const;
export const GEMINI_MID_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview"] as const;
export const OPENAI_MID_MODELS = ["gpt-5.4"] as const;

// Low-tier (used for title generation, lightweight extractions) — user picks
// one in account settings.
export const CLAUDE_LOW_MODELS = ["claude-haiku-5-5"] as const;
/** Previous low-tier id. Kept resolvable so a saved account preference still loads. */
export const CLAUDE_LEGACY_LOW_MODELS = ["claude-haiku-4-5"] as const;
export const GEMINI_LOW_MODELS = ["gemini-3.1-flash-lite"] as const;
export const OPENAI_LOW_MODELS = ["gpt-5.4-lite"] as const;

export const DEFAULT_MAIN_MODEL = "claude-fable-5-2";
export const DEFAULT_TITLE_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_TABULAR_MODEL = "gemini-3-flash-preview";

const ALL_MODELS = new Set<string>([
    ...CLAUDE_MAIN_MODELS,
    ...GEMINI_MAIN_MODELS,
    ...OPENAI_MAIN_MODELS,
    ...GROK_MAIN_MODELS,
    ...DEEPSEEK_MAIN_MODELS,
    ...MOONSHOT_MAIN_MODELS,
    ...CLAUDE_MID_MODELS,
    ...GEMINI_MID_MODELS,
    ...OPENAI_MID_MODELS,
    ...CLAUDE_LOW_MODELS,
    ...CLAUDE_LEGACY_LOW_MODELS,
    ...GEMINI_LOW_MODELS,
    ...OPENAI_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Provider inference
// ---------------------------------------------------------------------------

export function providerForModel(model: string): Provider {
    if (model.startsWith("claude")) return "claude";
    if (model.startsWith("gemini")) return "gemini";
    if (model.startsWith("gpt-")) return "openai";
    if (model.startsWith("fugu-")) return "sakana";
    if (model.startsWith("grok-")) return "xai";
    if (model.startsWith("deepseek-")) return "deepseek";
    if (model.startsWith("kimi-")) return "moonshot";
    throw new Error(`Unknown model id: ${model}`);
}

const KIMI_FLAG_TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Off unless KIMI_K31_PRO_ENABLED is an explicit truthy value. */
export function isKimiK31ProEnabled(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const raw = env.KIMI_K31_PRO_ENABLED?.trim().toLowerCase() ?? "";
    return KIMI_FLAG_TRUTHY.has(raw);
}

export function isKimiModelId(model: string): boolean {
    return model.trim().toLowerCase().startsWith("kimi-");
}

/** Kimi ids are selectable only while their flag is on. Every other id is. */
export function isSelectableModelId(
    model: string,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (isKimiModelId(model)) return isKimiK31ProEnabled(env);
    return true;
}

export function assertKimiSelectable(
    model: string,
    env: NodeJS.ProcessEnv = process.env,
): void {
    if (isSelectableModelId(model, env)) return;
    throw new Error(
        `Kimi is disabled (${model.trim()}). KIMI_K31_PRO_ENABLED is off and no Moonshot API key is wired.`,
    );
}

/** True for retired Sakana Fugu ids. Chat and council must not call these. */
export function isSakanaModelId(model: string): boolean {
    return model.startsWith("fugu-");
}

export function resolveModel(
    id: string | null | undefined,
    fallback: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    if (
        id &&
        ALL_MODELS.has(id) &&
        !isSponsorCiFencedModel(id, env) &&
        isSelectableModelId(id, env)
    ) {
        return id;
    }
    if (isSponsorCiFencedModel(fallback, env) || !isSelectableModelId(fallback, env)) {
        return DEFAULT_MAIN_MODEL;
    }
    return fallback;
}
