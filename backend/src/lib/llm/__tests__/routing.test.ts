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
  test("default chain is Gemini 4 Carbon → Grok 4.7 → Nemotron with no Claude or OpenAI hop", () => {
    clearRoutingEnv();
    const chain = resolveModelChain();
    assert.deepEqual(chain, [
      "gemini-4-carbon",
      "grok-4.7",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
    assert.equal(chain[0], "gemini-4-carbon");
    assert.equal(chain.some((id) => id.startsWith("claude") || id.startsWith("gpt-")), false);
    assert.equal(resolveActiveModel(), "gemini-4-carbon");
  });

  test("SAKANA_MODEL does not become primary or enter the default chain", () => {
    clearRoutingEnv();
    process.env.SAKANA_MODEL = "fugu-ultra-20260615";
    const chain = resolveModelChain();
    assert.equal(resolveActiveModel(), "gemini-4-carbon");
    assert.deepEqual(chain, [
      "gemini-4-carbon",
      "grok-4.7",
      "nvidia/nemotron-3-ultra-550b-a55b",
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
    assert.equal(resolveActiveModel(), "gemini-4-carbon");
    assert.deepEqual(resolveModelChain(), [
      "gemini-4-carbon",
      "grok-4.7",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
  });

  test("LLM_PROVIDER=anthropic does not change the Gemini default", () => {
    clearRoutingEnv();
    process.env.LLM_PROVIDER = "anthropic";
    assert.equal(resolveActiveModel(), "gemini-4-carbon");
  });

  test("LLM_MODEL naming Fugu is ignored and cannot become primary", () => {
    clearRoutingEnv();
    process.env.LLM_MODEL = "fugu-ultra-20260615";
    assert.equal(resolveActiveModel(), "gemini-4-carbon");
    assert.deepEqual(resolveModelChain(), [
      "gemini-4-carbon",
      "grok-4.7",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
  });

  test("LLM_MODEL still overrides the primary for an explicit Claude model", () => {
    clearRoutingEnv();
    process.env.LLM_MODEL = "claude-fable-5";
    assert.equal(resolveActiveModel(), "claude-fable-5");
    assert.deepEqual(resolveModelChain(), [
      "claude-fable-5",
      "grok-4.7",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
  });

  test("LLM_FALLBACK_MODEL drops Fugu and keeps the other hops", () => {
    clearRoutingEnv();
    process.env.LLM_MODEL = "claude-fable-5";
    process.env.LLM_FALLBACK_MODEL =
      "fugu-ultra-20260615,claude-opus-4-8,gpt-5.6-sol";
    assert.deepEqual(resolveModelChain(), [
      "claude-fable-5",
      "claude-opus-4-8",
      "gpt-5.6-sol",
    ]);
  });

  test("LLM_FALLBACK_MODEL dedupes the primary if it is repeated", () => {
    clearRoutingEnv();
    process.env.LLM_FALLBACK_MODEL =
      "gemini-4-carbon,grok-4.7,nvidia/nemotron-3-ultra-550b-a55b";
    assert.deepEqual(resolveModelChain(), [
      "gemini-4-carbon",
      "grok-4.7",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
  });

  test("LLM_MODEL=claude-fable-5-1 still resolves for rollback", () => {
    clearRoutingEnv();
    process.env.LLM_MODEL = "claude-fable-5-1";
    assert.equal(resolveActiveModel(), "claude-fable-5-1");
    assert.deepEqual(resolveModelChain(), [
      "claude-fable-5-1",
      "grok-4.7",
      "nvidia/nemotron-3-ultra-550b-a55b",
    ]);
  });
});

describe("provider_metadata routing trail", { concurrency: false }, () => {
  test("keeps answering-model keys and adds depth/attempted/skipped", () => {
    const skipped = [
      {
        provider_name: "claude",
        model_name: "claude-opus-5-5",
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
      ["claude-opus-5-5", "claude-fable-5"],
      skipped,
    );
    const persisted = persistableProviderMetadata(merged);
    assert.equal(persisted.provider_name, "claude");
    assert.equal(persisted.model_name, "claude-fable-5");
    assert.equal(persisted.provider_response_id, "msg_123");
    assert.equal(persisted.fallback_depth, 1);
    assert.deepEqual(persisted.attempted_models, [
      "claude-opus-5-5",
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
