/**
 * Sponsor-CI mode.
 *
 * Operators turn it on with `SPONSOR_CI_MODE=1` (also `true`, `yes`, `on`)
 * on the backend process. `user_profiles` has no settings column — organisation
 * is the company-voice name, not a feature flag — so there is no per-tenant
 * switch in the schema. `GET /user/profile` and unauthenticated `GET /healthz`
 * both echo this process flag. Optionally set
 * `NEXT_PUBLIC_SPONSOR_CI_MODE=1` on the frontend build so the picker is
 * fenced before that profile loads. That public value is inlined at build
 * time and can drift. The backend flag is what blocks use.
 *
 * Production is `NODE_ENV=production`. The backend Docker image sets that
 * for every Railway runtime. In production a missing, empty, or unrecognized
 * `SPONSOR_CI_MODE` is ON. Explicit `0` / `false` / `off` / `no` is OFF only
 * when `SPONSOR_CI_CHANGE_CONTROL_NOTE` is non-empty. Without that note the
 * process still boots and the OFF request is refused (fencing stays on).
 * A boot refusal would crash-loop the container for every tenant. Outside
 * production, unset stays off so local dev and unit tests are unchanged.
 *
 * While the mode is on:
 * - Sakana (`fugu-`), DeepSeek, and Kimi (`kimi-`) cannot sit on the
 *   council, cannot be the judge, and cannot join the default or fallback
 *   chain, even when an API key is configured. They are never
 *   auto-selected. The one exception is an explicit chat or connector pin
 *   of `kimi-k3.1-pro`, and only when `KIMI_K31_PRO_ENABLED` is exactly
 *   `true` (after trimming; `1`, `yes`, `on`, and `TRUE` do not count)
 *   and `MOONSHOT_API_KEY` is set. Every other `kimi-` id stays refused.
 *   With the flag off, the pin is refused exactly as before.
 * - Council seats and the judge stay on the locked frontier GA ids already
 *   on main. Chat hops that are not those frontier ids are dropped. The
 *   unpinned chat chain stays gemini-4-carbon → grok-4.7 → Nemotron.
 *   Sponsor-CI does not put Claude or OpenAI back on that chain. An
 *   explicit LLM_MODEL, LLM_FALLBACK_MODEL, or ask_mike pin may still
 *   name a frontier Claude or OpenAI id. `LLM_MODEL` and
 *   `LLM_FALLBACK_MODEL` cannot name Kimi.
 * - The fail-closed export attribution gate cannot be skipped. Docx, PDF,
 *   and legacy .doc were already gated. Plain text and any other download
 *   are scanned too.
 *
 * With the mode off, harden 1–3 behavior is unchanged: the docx/PDF/.doc
 * gate still fail-closes, and DeepSeek remains selectable by id outside
 * the picker.
 */

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const EXPLICIT_OFF = new Set(["0", "false", "off", "no"]);

export type SponsorCiModeDecision = {
  enabled: boolean;
  /** Production asked for OFF without a change-control note. Fencing stays on. */
  disableRefused: boolean;
};

/** Frontier GA ids Sponsor-CI chat, council, and judge stay on. */
export const SPONSOR_CI_FRONTIER_MODELS = [
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-fable-5-2",
  "claude-opus-5-5",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gemini-3.1-pro-preview",
  "gemini-4-carbon",
  "grok-4.7",
  "nvidia/nemotron-3-ultra-550b-a55b",
] as const;

const FRONTIER = new Set<string>(SPONSOR_CI_FRONTIER_MODELS);

function isProductionNodeEnv(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production";
}

function normalizedFlag(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function sponsorCiChangeControlNote(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.SPONSOR_CI_CHANGE_CONTROL_NOTE?.trim() ?? "";
}

/**
 * Production fail-closed decision. See the file header. Does not exit
 * the process: an explicit OFF without a note is refused and `enabled`
 * stays true.
 */
export function resolveSponsorCiMode(
  env: NodeJS.ProcessEnv = process.env,
): SponsorCiModeDecision {
  const raw = normalizedFlag(env.SPONSOR_CI_MODE);
  if (!isProductionNodeEnv(env)) {
    return { enabled: TRUTHY.has(raw), disableRefused: false };
  }
  if (!EXPLICIT_OFF.has(raw)) {
    return { enabled: true, disableRefused: false };
  }
  if (sponsorCiChangeControlNote(env).length > 0) {
    return { enabled: false, disableRefused: false };
  }
  return { enabled: true, disableRefused: true };
}

export function isSponsorCiMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveSponsorCiMode(env).enabled;
}

/** Logged once at boot when production OFF was refused. Null when there is nothing to say. */
export function sponsorCiBootWarning(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!resolveSponsorCiMode(env).disableRefused) return null;
  return "SPONSOR_CI_MODE is explicitly off in production but SPONSOR_CI_CHANGE_CONTROL_NOTE is empty. Refusing OFF; Sponsor-CI fencing stays on. The process still boots.";
}

/** Sakana Fugu, DeepSeek, and Kimi ids. Matched even when Sponsor-CI mode is off. */
export function isFencedModelId(model: string): boolean {
  const id = model.trim().toLowerCase();
  return id.startsWith("fugu-") || id.startsWith("deepseek-") || id.startsWith("kimi-");
}

export function isSponsorCiFencedModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isSponsorCiMode(env) && isFencedModelId(model);
}

const PINNED_KIMI_K31_PRO = "kimi-k3.1-pro";

/**
 * Exact id of the opt-in pin. Case and surrounding space do not create a
 * second id. `kimi-k3.1-pro-highspeed` and every other `kimi-` id stay out.
 */
function isPinnedKimiK31ProId(model: string): boolean {
  return model.trim().toLowerCase() === PINNED_KIMI_K31_PRO;
}

/**
 * Same gate as the pin itself: the flag is exactly "true" after trimming,
 * and a Moonshot key is present. This does not make the id selectable for
 * council, judge, resolveModel, or the fallback chain.
 */
function pinnedKimiK31ProReady(env: NodeJS.ProcessEnv): boolean {
  return (
    env.KIMI_K31_PRO_ENABLED?.trim() === "true" &&
    Boolean(env.MOONSHOT_API_KEY?.trim())
  );
}

export function isSponsorCiFrontierModel(model: string): boolean {
  return FRONTIER.has(model.trim());
}

/**
 * While Sponsor-CI mode is on, a Sakana, DeepSeek, or Kimi id is replaced
 * with `fallback`, including an otherwise allowed `kimi-k3.1-pro` pin.
 * Other ids pass through. The pin exception lives only in
 * `assertSponsorCiAllowsModel`.
 */
export function fenceModelId(
  model: string | null | undefined,
  fallback: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = model?.trim() ?? "";
  if (!trimmed || isSponsorCiFencedModel(trimmed, env)) return fallback;
  return trimmed;
}

/**
 * Throws before any provider call when Sponsor-CI mode refuses the id.
 *
 * Sakana, DeepSeek, and Kimi stay refused for council, the judge, and any
 * default or fallback hop. An explicit chat or connector pin of
 * `kimi-k3.1-pro` is the only exception, and only when the Kimi flag is
 * exactly `true` and `MOONSHOT_API_KEY` is set. The id stays fenced for
 * `resolveModel` and `fenceModelId`, so it is never auto-selected.
 */
export function assertSponsorCiAllowsModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isSponsorCiFencedModel(model, env)) return;
  if (isPinnedKimiK31ProId(model) && pinnedKimiK31ProReady(env)) return;
  throw new Error(
    `Sponsor-CI mode refuses ${model.trim()}. Sakana, DeepSeek, and Kimi cannot be used for chat, council, or judge, even when an API key is configured.`,
  );
}
