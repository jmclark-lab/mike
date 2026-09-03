import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  attachRoutingTrail,
  persistableProviderMetadata,
  resolveActiveModel,
  resolveModelChain,
} from "../index";

const ROUTING_ENV_KEYS = [
  "LLM_MODEL",
  "LLM_FALLBACK_MODEL",
  "LLM_PROVIDER",
  "SAKANA_MODEL",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ROUTING_ENV_KEYS) {
  saved.set(key, process.env[key]);
}

function clearRoutingEnv() {
  for (const key of ROUTING_ENV_KEYS) delete process.env[key];
}

function restoreRoutingEnv() {
  for (const key of ROUTING_ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreRoutingEnv);

describe("LLM routing chain", { concurrency: false }, () => {
  test("default chain is Fable → Opus → GPT-5.6 Sol with no Fugu hop", () => {
    clearRoutingEnv();
    assert.deepEqual(resolveModelChain(), [
      "claude-fable-5",
      "claude-opus-4-8",
      "gpt-5.6-sol",
    ]);
    assert.equal(resolveActiveModel(), "claude-fable-5");
  });

  test("SAKANA_MODEL does not become primary or enter the default chain", () => {
    clearRoutingEnv();
    process.env.SAKANA_MODEL = "fugu-ultra-20260615";
    const chain = resolveModelChain();
    assert.equal(resolveActiveModel(), "claude-fable-5");
    assert.deepEqual(chain, [
      "claude-fable-5",
      "claude-opus-4-8",
      "gpt-5.6-sol",
    ]);
    assert.equal(
      chain.some((id) => id.startsWith("fugu-")),
      false,
    );
  });

  test("LLM_PROVIDER=sakana does not promote Fugu to primary", () => {
    clearRoutingEnv();
    process.env.LLM_PROVIDER = "sakana";
    process.env.SAKANA_MODEL = "fugu-ultra-20260615";
    assert.equal(resolveActiveModel(), "claude-fable-5");
    assert.deepEqual(resolveModelChain(), [
      "claude-fable-5",
      "claude-opus-4-8",
      "gpt-5.6-sol",
    ]);
  });

  test("LLM_PROVIDER=anthropic does not change the Fable default", () => {
    clearRoutingEnv();
    process.env.LLM_PROVIDER = "anthropic";
    assert.equal(resolveActiveModel(), "claude-fable-5");
  });

  test("LLM_MODEL is a deliberate primary override, including Sakana", () => {
    clearRoutingEnv();
    process.env.LLM_MODEL = "fugu-ultra-20260615";
    assert.equal(resolveActiveModel(), "fugu-ultra-20260615");
    assert.deepEqual(resolveModelChain(), [
      "fugu-ultra-20260615",
      "claude-opus-4-8",
      "gpt-5.6-sol",
    ]);
  });

  test("LLM_FALLBACK_MODEL replaces the tail and can name Fugu explicitly", () => {
    clearRoutingEnv();
    process.env.LLM_MODEL = "claude-fable-5";
    process.env.LLM_FALLBACK_MODEL =
      "fugu-ultra-20260615,claude-opus-4-8,gpt-5.6-sol";
    assert.deepEqual(resolveModelChain(), [
      "claude-fable-5",
      "fugu-ultra-20260615",
      "claude-opus-4-8",
      "gpt-5.6-sol",
    ]);
  });

  test("LLM_FALLBACK_MODEL dedupes the primary if it is repeated", () => {
    clearRoutingEnv();
    process.env.LLM_FALLBACK_MODEL = "claude-fable-5,claude-opus-4-8,gpt-5.6-sol";
    assert.deepEqual(resolveModelChain(), [
      "claude-fable-5",
      "claude-opus-4-8",
      "gpt-5.6-sol",
    ]);
  });
});

describe("provider_metadata routing trail", { concurrency: false }, () => {
  test("keeps answering-model keys and adds depth/attempted/skipped", () => {
    const skipped = [
      {
        provider_name: "sakana_fugu",
        model_name: "fugu-ultra-20260615",
        failure_class: "timeout",
        failure_reason: "timed out",
      },
    ];
    const merged = attachRoutingTrail(
      {
        provider_name: "claude",
        model_name: "claude-fable-5",
        provider_response_id: "msg_123",
      },
      "claude-fable-5",
      1,
      ["fugu-ultra-20260615", "claude-fable-5"],
      skipped,
    );
    const persisted = persistableProviderMetadata(merged);
    assert.equal(persisted.provider_name, "claude");
    assert.equal(persisted.model_name, "claude-fable-5");
    assert.equal(persisted.provider_response_id, "msg_123");
    assert.equal(persisted.fallback_depth, 1);
    assert.deepEqual(persisted.attempted_models, [
      "fugu-ultra-20260615",
      "claude-fable-5",
    ]);
    assert.deepEqual(persisted.skipped_models, skipped);
  });

  test("records an empty skipped_models list when the first hop answered", () => {
    const persisted = persistableProviderMetadata(
      attachRoutingTrail(
        { provider_name: "claude", model_name: "claude-fable-5" },
        "claude-fable-5",
        0,
        ["claude-fable-5"],
        [],
      ),
    );
    assert.equal(persisted.fallback_depth, 0);
    assert.deepEqual(persisted.attempted_models, ["claude-fable-5"]);
    assert.deepEqual(persisted.skipped_models, []);
  });

  test("missing metadata keeps provider_name and model_name keys", () => {
    const persisted = persistableProviderMetadata(null);
    assert.equal(persisted.provider_name, "unknown");
    assert.equal(persisted.model_name, "unknown");
    assert.equal("fallback_depth" in persisted, false);
  });
});
