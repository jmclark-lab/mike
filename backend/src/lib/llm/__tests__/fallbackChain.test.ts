import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
    buildRoutedChain,
    getRoutingHealth,
    resetRoutingHealthForTests,
    resolveModelChain,
    runFallbackChain,
} from "../index";

const saved: Record<string, string | undefined> = {};

function stash(keys: string[]) {
    for (const key of keys) saved[key] = process.env[key];
}

function restore(keys: string[]) {
    for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
}

const ENV_KEYS = ["LLM_MODEL", "LLM_FALLBACK_MODEL", "LLM_PROVIDER", "SAKANA_MODEL"];

beforeEach(() => {
    stash(ENV_KEYS);
    for (const key of ENV_KEYS) delete process.env[key];
    resetRoutingHealthForTests();
});

afterEach(() => {
    restore(ENV_KEYS);
    resetRoutingHealthForTests();
});

test("default configured chain keeps Fugu Ultra as the lead seat", () => {
    assert.deepEqual(resolveModelChain(), [
        "fugu-ultra-20260615",
        "claude-fable-5",
        "claude-opus-4-8",
        "gpt-5.6-sol",
    ]);
    const health = getRoutingHealth();
    assert.equal(health.chain[0], "fugu-ultra-20260615");
    assert.equal(health.first_model_by_bucket.default, "fugu-ultra-20260615");
    assert.equal(health.first_model_by_bucket.cheap, "fugu-ultra-20260615");
    assert.equal(health.first_model_by_bucket.high, "claude-opus-4-8");
    assert.equal(typeof health.providers_configured.sakana, "boolean");
    assert.equal(health.search_router_mode, "off");
});

test("fallback still runs after the intent-picked first model misses", async () => {
    const routed = buildRoutedChain({
        bucket: "default",
        fallbackPool: resolveModelChain(),
    });
    assert.equal(routed.firstModel, "fugu-ultra-20260615");
    assert.equal(routed.chain[0], "fugu-ultra-20260615");

    const attempted: string[] = [];
    const outcome = await runFallbackChain({
        chain: routed.chain,
        invoke: async (model) => {
            attempted.push(model);
            if (model === routed.firstModel) {
                throw new Error("timeout from fugu-ultra-20260615");
            }
            return `ok from ${model}`;
        },
        isEmpty: (text) => !text.trim(),
    });

    assert.equal(attempted[0], "fugu-ultra-20260615");
    assert.ok(attempted.length >= 2);
    assert.equal(outcome.answered, attempted[1]);
    assert.equal(outcome.fallbackDepth, 1);
    assert.deepEqual(outcome.attempted, attempted);
    assert.equal(outcome.result, `ok from ${attempted[1]}`);
});

test("empty first-model response also advances the fallback chain", async () => {
    const routed = buildRoutedChain({
        bucket: "high",
        fallbackPool: resolveModelChain(),
    });
    assert.equal(routed.firstModel, "claude-opus-4-8");

    const attempted: string[] = [];
    const outcome = await runFallbackChain({
        chain: routed.chain,
        invoke: async (model) => {
            attempted.push(model);
            if (model === routed.firstModel) return "   ";
            return "signed-document answer";
        },
        isEmpty: (text) => !text.trim(),
    });

    assert.equal(attempted[0], "claude-opus-4-8");
    assert.equal(outcome.fallbackDepth, 1);
    assert.equal(outcome.result, "signed-document answer");
    assert.notEqual(outcome.answered, routed.firstModel);
});

test("LLM_MODEL still overrides the configured pool primary", () => {
    process.env.LLM_MODEL = "claude-fable-5";
    assert.equal(resolveModelChain()[0], "claude-fable-5");
    assert.ok(resolveModelChain().includes("fugu-ultra-20260615"));
});
