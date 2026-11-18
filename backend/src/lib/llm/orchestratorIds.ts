/**
 * Perplexity Orchestrator model ids. No imports, so models.ts, sponsorCiMode.ts and council.ts can all use it.
 *
 * Mike's id for an Orchestrator-served model is `orchestrator/<vendor>/<model>`, e.g.
 * `orchestrator/anthropic/claude-haiku-5-5`. The part after `orchestrator/` is the exact id the Orchestrator catalog
 * uses (docs.perplexity.ai/docs/orchestrator/models). The prefix keeps these ids from ever being mistaken for the
 * direct-provider id of the same model, so no existing id changes meaning.
 */
export const ORCHESTRATOR_MODEL_PREFIX = "orchestrator/";

/** True for any id in the Orchestrator namespace, valid or not. */
export function isOrchestratorModelId(model: string): boolean {
    return model.trim().toLowerCase().startsWith(ORCHESTRATOR_MODEL_PREFIX);
}

/**
 * The Orchestrator catalog id (`vendor/model`) for a Mike Orchestrator id, or null when the id is malformed or is
 * `perplexity/auto`. Auto is refused: it picks a model per request, so cost and data path are not pinned
 * (2026-11-18 test: it chose gpt-6.1-sol, ~20x the cost and 19.9 s).
 */
export function orchestratorWireModel(model: string): string | null {
    const id = model.trim();
    if (!isOrchestratorModelId(id)) return null;
    const wire = id.slice(ORCHESTRATOR_MODEL_PREFIX.length);
    if (!/^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(wire)) return null;
    if (wire === "perplexity/auto") return null;
    return wire;
}
