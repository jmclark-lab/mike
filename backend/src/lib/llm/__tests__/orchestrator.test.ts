import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  COUNCIL_JUDGE,
  COUNCIL_MEMBERS,
  resolveCouncilJudge,
  resolveCouncilSeats,
} from "../council";
import {
  chatModelsForRequest,
  completeTextStrict,
  resolveModelChain,
  streamChatWithTools,
} from "../index";
import {
  DEFAULT_MAIN_MODEL,
  isOrchestratorModelId,
  isSelectableModelId,
  orchestratorWireModel,
  providerForModel,
  resolveModel,
} from "../models";
import {
  DEFAULT_ORCHESTRATOR_BASE_URL,
  ORCHESTRATOR_MIN_OUTPUT_TOKENS,
  assertOrchestratorSelectable,
  completeOrchestratorText,
  isOrchestratorReady,
  orchestratorOutputTokens,
  orchestratorUsageCostUsd,
  streamOrchestrator,
} from "../orchestrator";

const ENV_KEYS = [
  "ORCHESTRATOR_ENABLED",
  "ORCHESTRATOR_API_KEY",
  "ORCHESTRATOR_BASE_URL",
  "PERPLEXITY_API_KEY",
  "LLM_MODEL",
  "LLM_FALLBACK_MODEL",
  "SPONSOR_CI_MODE",
  "NODE_ENV",
] as const;
const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}
function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
afterEach(restoreEnv);

const HAIKU = "orchestrator/anthropic/claude-haiku-5-5";

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function installFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response) {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init, body: JSON.parse(String(init?.body ?? "{}")) });
    return handler(input, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function header(init: RequestInit | undefined, name: string): string {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.[name] ?? "";
}

describe("Orchestrator ids", { concurrency: false }, () => {
  test("orchestrator/<vendor>/<model> resolves to provider orchestrator and the exact catalog id", () => {
    assert.equal(providerForModel(HAIKU), "orchestrator");
    assert.equal(isOrchestratorModelId(HAIKU), true);
    assert.equal(orchestratorWireModel(HAIKU), "anthropic/claude-haiku-5-5");
    assert.equal(orchestratorWireModel("orchestrator/openai/gpt-6.1-sol"), "openai/gpt-6.1-sol");
    // The direct-provider id of the same model keeps its meaning.
    assert.equal(providerForModel("claude-haiku-5-5"), "claude");
  });

  test("perplexity/auto and malformed ids are refused", () => {
    assert.equal(orchestratorWireModel("orchestrator/perplexity/auto"), null);
    assert.equal(orchestratorWireModel("orchestrator/auto"), null);
    assert.equal(orchestratorWireModel("orchestrator/"), null);
    assert.equal(orchestratorWireModel("orchestrator/a/b/c"), null);
    assert.equal(orchestratorWireModel("claude-haiku-5-5"), null);
  });

  test("they are not in the picker set: resolveModel falls back", () => {
    assert.equal(resolveModel(HAIKU, DEFAULT_MAIN_MODEL), DEFAULT_MAIN_MODEL);
  });
});

describe("Orchestrator is off by default", { concurrency: false }, () => {
  test("not ready and not selectable without the flag, even with a key", () => {
    clearEnv();
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    assert.equal(isOrchestratorReady(), false);
    assert.equal(isSelectableModelId(HAIKU), false);
    for (const value of ["1", "yes", "on", "TRUE", "false", ""]) {
      process.env.ORCHESTRATOR_ENABLED = value;
      assert.equal(isOrchestratorReady(), false, value);
    }
  });

  test("flag without a key is still not selectable", () => {
    clearEnv();
    process.env.ORCHESTRATOR_ENABLED = "true";
    assert.equal(isSelectableModelId(HAIKU), false);
  });

  test("flag plus key makes a pinned id selectable, but never perplexity/auto", () => {
    clearEnv();
    process.env.ORCHESTRATOR_ENABLED = "true";
    process.env.ORCHESTRATOR_API_KEY = "pplx-test";
    assert.equal(isSelectableModelId(HAIKU), true);
    assert.equal(isSelectableModelId("orchestrator/perplexity/auto"), false);
  });

  test("assertOrchestratorSelectable explains each refusal", () => {
    clearEnv();
    assert.throws(() => assertOrchestratorSelectable(HAIKU, { sponsorCi: false }), /switched off/);
    process.env.ORCHESTRATOR_ENABLED = "true";
    assert.throws(() => assertOrchestratorSelectable(HAIKU, { sponsorCi: false }), /requires ORCHESTRATOR_API_KEY or PERPLEXITY_API_KEY/);
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    assert.doesNotThrow(() => assertOrchestratorSelectable(HAIKU, { sponsorCi: false }));
    assert.throws(() => assertOrchestratorSelectable("orchestrator/perplexity/auto", { sponsorCi: false }), /not a pinned id/);
    assert.throws(() => assertOrchestratorSelectable(HAIKU, { sponsorCi: true }), /Sponsor-CI mode refuses/);
    // Non-Orchestrator ids are untouched.
    assert.doesNotThrow(() => assertOrchestratorSelectable("claude-fable-5-2", { sponsorCi: true }));
  });
});

describe("Orchestrator never changes the frontier policy", { concurrency: false }, () => {
  test("default chain is unchanged with the flag on", () => {
    clearEnv();
    process.env.ORCHESTRATOR_ENABLED = "true";
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    assert.deepEqual(resolveModelChain(), ["gemini-4-carbon", "grok-4.7", "nvidia/nemotron-3-ultra-550b-a55b"]);
  });

  test("an operator can name an Orchestrator id in LLM_MODEL / LLM_FALLBACK_MODEL only while ready and outside Sponsor-CI", () => {
    clearEnv();
    process.env.LLM_MODEL = "orchestrator/xai/grok-4.7";
    assert.equal(resolveModelChain().includes("orchestrator/xai/grok-4.7"), false);
    process.env.ORCHESTRATOR_ENABLED = "true";
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    assert.equal(resolveModelChain()[0], "orchestrator/xai/grok-4.7");
    process.env.SPONSOR_CI_MODE = "1";
    assert.deepEqual(resolveModelChain(), ["gemini-4-carbon", "grok-4.7", "nvidia/nemotron-3-ultra-550b-a55b"]);
  });

  test("council seats and judge ignore Orchestrator overrides", () => {
    const seats = resolveCouncilSeats({
      COUNCIL_ANTHROPIC_MODEL: "orchestrator/anthropic/claude-fable-5-2",
      COUNCIL_OPENAI_MODEL: "orchestrator/openai/gpt-6-astra",
      COUNCIL_GEMINI_MODEL: "orchestrator/google/gemini-3.8-flash",
      COUNCIL_XAI_MODEL: "orchestrator/xai/grok-4.7",
    });
    assert.deepEqual(seats.map((seat) => seat.model), [...COUNCIL_MEMBERS]);
    assert.deepEqual([...COUNCIL_MEMBERS], ["claude-fable-5-2", "gpt-6-astra", "gemini-4-carbon", "grok-4.7"]);
    assert.equal(resolveCouncilJudge({ COUNCIL_JUDGE: "orchestrator/anthropic/claude-opus-4-8" }), COUNCIL_JUDGE);
  });

  test("the strict (council) completion path rejects Orchestrator ids even when the flag is on", async () => {
    clearEnv();
    process.env.ORCHESTRATOR_ENABLED = "true";
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    const fetchStub = installFetch(() => {
      throw new Error("no request may be sent");
    });
    try {
      await assert.rejects(() => completeTextStrict({ model: HAIKU, user: "synthetic clause" }), /cannot use/);
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  test("a strict pin keeps a single hop and does not fall back", () => {
    const pinned = chatModelsForRequest({ strictModel: true, model: HAIKU });
    assert.deepEqual(pinned, { models: [HAIKU], strict: true });
  });

  test("a strict stream pin is refused before any request while Sponsor-CI is on, and while the flag is off", async () => {
    clearEnv();
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    const fetchStub = installFetch(() => {
      throw new Error("no request may be sent");
    });
    const pin = () =>
      streamChatWithTools({ model: HAIKU, strictModel: true, systemPrompt: "s", messages: [{ role: "user", content: "q" }] });
    try {
      await assert.rejects(pin, /switched off/);
      process.env.ORCHESTRATOR_ENABLED = "true";
      process.env.SPONSOR_CI_MODE = "1";
      await assert.rejects(pin, /Sponsor-CI mode refuses/);
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  test("a strict stream pin reaches the Orchestrator when ready and Sponsor-CI is off, with no fallback hop", async () => {
    clearEnv();
    process.env.ORCHESTRATOR_ENABLED = "true";
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    const fetchStub = installFetch(() => sseResponse([{ id: "r9", choices: [{ delta: { content: "pinned answer" }, finish_reason: "stop" }] }]));
    try {
      const result = await streamChatWithTools({
        model: HAIKU,
        strictModel: true,
        systemPrompt: "s",
        messages: [{ role: "user", content: "synthetic question" }],
      });
      assert.equal(result.fullText, "pinned answer");
      assert.equal(result.providerMetadata?.provider_name, "orchestrator");
      assert.equal(result.providerMetadata?.model_name, HAIKU);
      assert.equal(fetchStub.calls.length, 1);
      assert.equal(fetchStub.calls[0]!.body.model, "anthropic/claude-haiku-5-5");
    } finally {
      fetchStub.restore();
    }
  });
});

describe("Orchestrator adapter", { concurrency: false }, () => {
  function ready() {
    clearEnv();
    process.env.ORCHESTRATOR_ENABLED = "true";
    process.env.PERPLEXITY_API_KEY = "pplx-test";
  }

  test("streams Chat Completions to the pinned catalog id with the Perplexity key and keeps reasoning out of the answer", async () => {
    ready();
    const fetchStub = installFetch(() =>
      sseResponse([
        { id: "r1", choices: [{ delta: { reasoning_content: "thinking about clause 4" } }] },
        { choices: [{ delta: { content: "Clause 4 is " } }] },
        { choices: [{ delta: { content: "unusual." }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 500 } },
      ]),
    );
    const deltas: string[] = [];
    try {
      const result = await streamOrchestrator({
        model: HAIKU,
        systemPrompt: "You are Mike.",
        messages: [{ role: "user", content: "Is clause 4 unusual? (synthetic)" }],
        callbacks: { onContentDelta: (text) => deltas.push(text) },
      });
      assert.equal(result.fullText, "Clause 4 is unusual.");
      assert.deepEqual(deltas, ["Clause 4 is ", "unusual."]);
      assert.equal(result.providerMetadata?.provider_name, "orchestrator");
      assert.equal(result.providerMetadata?.model_name, HAIKU);
      assert.equal(result.providerMetadata?.provider_response_id, "r1");
      const call = fetchStub.calls[0]!;
      assert.equal(call.url, `${DEFAULT_ORCHESTRATOR_BASE_URL}/chat/completions`);
      assert.equal(header(call.init, "Authorization"), "Bearer pplx-test");
      assert.equal(call.body.model, "anthropic/claude-haiku-5-5");
      assert.equal(call.body.stream, true);
      assert.deepEqual(call.body.stream_options, { include_usage: true });
      assert.ok((call.body.max_completion_tokens as number) >= ORCHESTRATOR_MIN_OUTPUT_TOKENS);
      assert.equal("reasoning_effort" in call.body, false);
      assert.notEqual(call.body.model, "perplexity/auto");
    } finally {
      fetchStub.restore();
    }
  });

  test("replays the whole conversation on a tool iteration (the API is stateless) and never sends previous_response_id", async () => {
    ready();
    let n = 0;
    const fetchStub = installFetch(() => {
      n += 1;
      if (n === 1) {
        return sseResponse([
          {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_doc", arguments: '{"doc":"a"}' } }] },
                finish_reason: "tool_calls",
              },
            ],
          },
        ]);
      }
      return sseResponse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
    });
    try {
      const result = await streamOrchestrator({
        model: HAIKU,
        systemPrompt: "sys",
        messages: [{ role: "user", content: "q" }],
        tools: [{ type: "function", function: { name: "read_doc", description: "d", parameters: { type: "object" } } }],
        runTools: async (calls) => calls.map((call) => ({ tool_use_id: call.id, content: "synthetic text" })),
      });
      assert.equal(result.fullText, "done");
      const second = fetchStub.calls[1]!.body;
      assert.equal("previous_response_id" in second, false);
      const roles = (second.messages as { role: string }[]).map((m) => m.role);
      assert.deepEqual(roles, ["system", "user", "assistant", "tool"]);
    } finally {
      fetchStub.restore();
    }
  });

  test("an empty answer throws an 'empty' error (retryable by the shared fallback path)", async () => {
    ready();
    const fetchStub = installFetch(() => sseResponse([{ choices: [{ delta: { content: null }, finish_reason: "length" }] }]));
    try {
      await assert.rejects(
        () => streamOrchestrator({ model: HAIKU, systemPrompt: "s", messages: [{ role: "user", content: "q" }] }),
        /empty response/,
      );
    } finally {
      fetchStub.restore();
    }
  });

  test("an HTTP 429 surfaces the status so the shared classifier can retry or fall back", async () => {
    ready();
    const fetchStub = installFetch(() => new Response('{"error":{"message":"rate limited"}}', { status: 429 }));
    try {
      await assert.rejects(
        () => completeOrchestratorText({ model: HAIKU, user: "q" }),
        /Orchestrator request failed \(429\)/,
      );
    } finally {
      fetchStub.restore();
    }
  });

  test("completeOrchestratorText floors the completion budget and passes ask effort through", async () => {
    ready();
    const fetchStub = installFetch(() => sseResponse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]));
    try {
      const text = await completeOrchestratorText({ model: HAIKU, user: "q", maxTokens: 400, effort: "high" });
      assert.equal(text, "ok");
      assert.equal(fetchStub.calls[0]!.body.max_completion_tokens, ORCHESTRATOR_MIN_OUTPUT_TOKENS);
      assert.equal(fetchStub.calls[0]!.body.reasoning_effort, "high");
      assert.equal(orchestratorOutputTokens(100_000), 100_000);
    } finally {
      fetchStub.restore();
    }
  });

  test("a missing key throws before any request", async () => {
    clearEnv();
    const fetchStub = installFetch(() => {
      throw new Error("no request may be sent");
    });
    try {
      await assert.rejects(() => completeOrchestratorText({ model: HAIKU, user: "q" }), /API key is not configured/);
      assert.equal(fetchStub.calls.length, 0);
    } finally {
      fetchStub.restore();
    }
  });

  test("usage cost uses pricing.ts rates and is null for unpriced models", () => {
    assert.equal(orchestratorUsageCostUsd("anthropic/claude-haiku-5-5", 1000, 500), 0.00035);
    assert.equal(orchestratorUsageCostUsd("anthropic/claude-haiku-5-5", null, 500), null);
    assert.equal(orchestratorUsageCostUsd("openai/gpt-5-mini", 1000, 500), null);
  });
});
