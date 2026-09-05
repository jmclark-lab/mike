import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  DEFAULT_MAIN_MODEL,
  GROK_MAIN_MODELS,
  providerForModel,
  resolveModel,
} from "../models";
import { resolveModelChain } from "../index";
import { COUNCIL_MEMBERS } from "../council";
import {
  completeXaiText,
  DEFAULT_XAI_BASE_URL,
  xaiBaseUrl,
  xaiClient,
} from "../xai";
import { openAICompatibleResponsesUrl } from "../openai";

const XAI_ENV_KEYS = ["XAI_API_KEY", "XAI_BASE_URL"] as const;
const saved = new Map<string, string | undefined>();
for (const key of XAI_ENV_KEYS) saved.set(key, process.env[key]);

function restoreXaiEnv() {
  for (const key of XAI_ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreXaiEnv);

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n";
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

describe("xAI Grok selectable-only wiring", { concurrency: false }, () => {
  test("GROK_MAIN_MODELS is grok-4.6 and resolves to provider xai", () => {
    assert.deepEqual([...GROK_MAIN_MODELS], ["grok-4.6"]);
    assert.equal(providerForModel("grok-4.6"), "xai");
    assert.equal(resolveModel("grok-4.6", DEFAULT_MAIN_MODEL), "grok-4.6");
    assert.equal(DEFAULT_MAIN_MODEL, "claude-fable-5-1");
  });

  test("Grok is not in the default chat fallback chain", () => {
    delete process.env.LLM_MODEL;
    delete process.env.LLM_FALLBACK_MODEL;
    delete process.env.LLM_PROVIDER;
    delete process.env.SAKANA_MODEL;
    const chain = resolveModelChain();
    assert.equal(
      chain.some((id) => id.startsWith("grok-")),
      false,
    );
    assert.deepEqual(chain, [
      "claude-fable-5-1",
      "claude-opus-5",
      "gpt-6-astra",
    ]);
  });

  test("Grok is the fifth legal-council seat (Astra OpenAI slot stays)", () => {
    assert.equal(COUNCIL_MEMBERS.includes("grok-4.6"), true);
    assert.equal(COUNCIL_MEMBERS.includes("gpt-6-astra"), true);
    assert.equal(COUNCIL_MEMBERS.includes("claude-fable-5-1"), true);
    assert.equal(COUNCIL_MEMBERS.length, 5);
    assert.equal(COUNCIL_MEMBERS.at(-1), "grok-4.6");
  });

  test("xAI client uses https://api.x.ai/v1 and XAI_API_KEY", () => {
    delete process.env.XAI_BASE_URL;
    process.env.XAI_API_KEY = "test-xai-key";
    assert.equal(xaiBaseUrl(), DEFAULT_XAI_BASE_URL);
    assert.equal(DEFAULT_XAI_BASE_URL, "https://api.x.ai/v1");
    const client = xaiClient();
    assert.equal(client.provider, "xai");
    assert.equal(client.baseUrl, "https://api.x.ai/v1");
    assert.equal(client.apiKey, "test-xai-key");
    assert.equal(
      openAICompatibleResponsesUrl(client.baseUrl),
      "https://api.x.ai/v1/responses",
    );
  });

  test("xaiClient throws when XAI_API_KEY is missing", () => {
    delete process.env.XAI_API_KEY;
    assert.throws(() => xaiClient(), /XAI_API_KEY/);
  });

  test("completeXaiText posts grok-4.6 to the xAI Responses URL", async () => {
    process.env.XAI_API_KEY = "test-xai-key";
    delete process.env.XAI_BASE_URL;
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    let authHeader = "";
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      authHeader = String(
        init?.headers &&
          typeof init.headers === "object" &&
          "Authorization" in init.headers
          ? (init.headers as { Authorization?: string }).Authorization
          : "",
      );
      requestBody = JSON.parse(String(init?.body));
      return sseResponse([
        { type: "response.output_text.delta", delta: "grok " },
        { type: "response.output_text.delta", delta: "ok" },
        {
          type: "response.completed",
          response: { status: "completed", output_text: "grok ok" },
        },
      ]);
    };

    try {
      const result = await completeXaiText({
        model: "grok-4.6",
        user: "ping",
      });
      assert.equal(result, "grok ok");
      assert.equal(requestedUrl, "https://api.x.ai/v1/responses");
      assert.equal(requestBody?.model, "grok-4.6");
      assert.equal(requestBody?.stream, true);
      assert.equal(authHeader.startsWith("Bearer "), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
