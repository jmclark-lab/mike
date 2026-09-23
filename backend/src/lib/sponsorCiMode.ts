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
 * - Sakana (`fugu-`) and DeepSeek cannot be selected, cannot sit on the
 *   council, and cannot be the judge, even when an API key is configured.
 * - Council seats and the judge stay on the locked frontier GA ids already
 *   on main. Chat hops that are not those frontier ids are dropped, and the
 *   default Fable → Opus 5.5 → Astra chain is kept.
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
  "claude-opus-5-5",
  "gpt-6-astra",
  "gemini-3.1-pro-preview",
  "grok-4.7",
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

/** Sakana Fugu and DeepSeek ids. Matched even when Sponsor-CI mode is off. */
export function isFencedModelId(model: string): boolean {
  const id = model.trim().toLowerCase();
  return id.startsWith("fugu-") || id.startsWith("deepseek-");
}

export function isSponsorCiFencedModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isSponsorCiMode(env) && isFencedModelId(model);
}

export function isSponsorCiFrontierModel(model: string): boolean {
  return FRONTIER.has(model.trim());
}

/**
 * While Sponsor-CI mode is on, a Sakana or DeepSeek id is replaced with
 * `fallback`. Other ids pass through.
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
 * API keys are irrelevant: the refusal happens before the adapter.
 */
export function assertSponsorCiAllowsModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isSponsorCiFencedModel(model, env)) return;
  throw new Error(
    `Sponsor-CI mode refuses ${model.trim()}. Sakana and DeepSeek cannot be used for chat, council, or judge, even when an API key is configured.`,
  );
}
