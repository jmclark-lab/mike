import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ConnectorJobManager, readMikeSseResult } from "../connectorJobs";
import {
  connectorModelAllowedValues,
  parseConnectorModelChoice,
} from "../connectorModelChoice";
import {
  chatModelsForRequest,
  resetRoutingHealthForTests,
  resolveModelChain,
  runChatModelAttempts,
} from "../llm";

const saved = {
  LLM_MODEL: process.env.LLM_MODEL,
  LLM_FALLBACK_MODEL: process.env.LLM_FALLBACK_MODEL,
  SPONSOR_CI_MODE: process.env.SPONSOR_CI_MODE,
};

afterEach(() => {
  resetRoutingHealthForTests();
  for (const key of ["LLM_MODEL", "LLM_FALLBACK_MODEL", "SPONSOR_CI_MODE"] as const) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("connector model aliases resolve to the current ids", () => {
  assert.deepEqual(parseConnectorModelChoice(undefined), {
    ok: true,
    model: undefined,
    provider: undefined,
  });
  assert.deepEqual(parseConnectorModelChoice("gemini"), {
    ok: true,
    model: "gemini-4-carbon",
    provider: "google",
  });
  assert.deepEqual(parseConnectorModelChoice(" Claude "), {
    ok: true,
    model: "claude-fable-5-2",
    provider: "anthropic",
  });
  assert.deepEqual(parseConnectorModelChoice("openai"), {
    ok: true,
    model: "gpt-6-astra",
    provider: "openai",
  });
  assert.deepEqual(parseConnectorModelChoice("gpt"), {
    ok: true,
    model: "gpt-6-astra",
    provider: "openai",
  });
  assert.deepEqual(parseConnectorModelChoice("grok"), {
    ok: true,
    model: "grok-4.7",
    provider: "xai",
  });
  assert.equal(parseConnectorModelChoice("claude-opus-5-5").ok, true);
});

test("an unknown connector model is rejected with the allowed values", () => {
  const parsed = parseConnectorModelChoice("claude-haiku");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.detail, /Unknown model "claude-haiku"/);
  assert.deepEqual(parsed.allowed, connectorModelAllowedValues());
  for (const allowed of [
    "gemini-4-carbon",
    "gemini",
    "claude-fable-5-2",
    "claude-opus-5-5",
    "gpt-6-astra",
    "grok-4.7",
  ]) {
    assert.match(parsed.detail, new RegExp(allowed));
  }
});

test("the worker schema lists the same model ids and aliases", () => {
  const worker = fs.readFileSync(
    path.resolve(__dirname, "../../../../connectors/mike-assistant/worker.js"),
    "utf8",
  );
  for (const allowed of connectorModelAllowedValues()) {
    assert.match(worker, new RegExp(`"${allowed}"`));
  }
});

test("omitting model keeps the default chain, including under Sponsor-CI", () => {
  resetRoutingHealthForTests();
  delete process.env.LLM_MODEL;
  delete process.env.LLM_FALLBACK_MODEL;
  process.env.SPONSOR_CI_MODE = "1";
  const chain = chatModelsForRequest({
    strictModel: false,
    model: "gemini-4-carbon",
  });
  assert.equal(chain.strict, false);
  assert.deepEqual(chain.models, resolveModelChain());
  assert.deepEqual(chain.models, [
    "claude-fable-5-2",
    "claude-opus-5-5",
    "gpt-6-astra",
  ]);
});

test("an explicit model is the only attempt and a failure does not fall back", async () => {
  const seen: string[] = [];
  await assert.rejects(
    () =>
      runChatModelAttempts({
        models: ["gemini-4-carbon", "claude-fable-5-2", "gpt-6-astra"],
        strict: true,
        invoke: async (model) => {
          seen.push(model);
          throw new Error("Gemini error: timed out");
        },
      }),
    /Model gemini-4-carbon failed with no fallback: Gemini error: timed out/,
  );
  assert.deepEqual(seen, ["gemini-4-carbon"]);
});

test("the default chain still falls back and reports the model that answered", async () => {
  resetRoutingHealthForTests();
  const seen: string[] = [];
  const result = await runChatModelAttempts({
    models: ["claude-fable-5-2", "claude-opus-5-5", "gpt-6-astra"],
    strict: false,
    invoke: async (model) => {
      seen.push(model);
      if (model !== "gpt-6-astra") throw new Error(`timeout from ${model}`);
      return { fullText: "the indemnity is mutual" };
    },
  });
  assert.deepEqual(seen, [
    "claude-fable-5-2",
    "claude-opus-5-5",
    "gpt-6-astra",
  ]);
  assert.equal(result.providerMetadata?.provider_name, "openai");
  assert.equal(result.providerMetadata?.model_name, "gpt-6-astra");
  assert.equal(result.providerMetadata?.fallback_depth, 2);
  assert.deepEqual(result.providerMetadata?.attempted_models, seen);
});

test("SSE answers carry the provider and model that produced them", async () => {
  const response = new Response(
    [
      'data: {"type":"content_delta","text":"Reviewed."}',
      'data: {"type":"provider_metadata","provider_name":"openai","model_name":"gpt-6-astra","fallback":true,"fallback_depth":2}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  const result = await readMikeSseResult(response);
  assert.equal(result.text, "Reviewed.");
  assert.equal(result.provider, "openai");
  assert.equal(result.model, "gpt-6-astra");
  assert.equal(result.fallback, true);
  assert.equal(result.fallback_depth, 2);
});

test("connector jobs persist the answering model for a later poll", async () => {
  const manager = new ConnectorJobManager(async () => ({
    text: "Reviewed.",
    provider: "google",
    model: "gemini-4-carbon",
    fallback: false,
    fallback_depth: 0,
  }));
  manager.startOrGet("job-model", "Review", { model: "gemini-4-carbon" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const done = manager.startOrGet("job-model", "Review");
  assert.equal(done.status, "done");
  if (done.status !== "done") return;
  assert.equal(done.text, "Reviewed.");
  assert.equal(done.provider, "google");
  assert.equal(done.model, "gemini-4-carbon");
  assert.equal(done.fallback, false);
  assert.equal(done.fallback_depth, 0);
});
