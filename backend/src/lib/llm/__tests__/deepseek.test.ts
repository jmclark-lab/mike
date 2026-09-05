import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  DEFAULT_MAIN_MODEL,
  DEEPSEEK_MAIN_MODELS,
  providerForModel,
  resolveModel,
} from "../models";
import { resolveModelChain } from "../index";
import { COUNCIL_MEMBERS } from "../council";
import {
  completeDeepSeekText,
  DEFAULT_DEEPSEEK_BASE_URL,
  deepseekBaseUrl,
  deepseekChatCompletionsUrl,
  deepseekClient,
} from "../deepseek";

const DEEPSEEK_ENV_KEYS = ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const;
const saved = new Map<string, string | undefined>();
for (const key of DEEPSEEK_ENV_KEYS) saved.set(key, process.env[key]);

function restoreDeepSeekEnv() {
  for (const key of DEEPSEEK_ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreDeepSeekEnv);

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

describe("DeepSeek selectable-only wiring", { concurrency: false }, () => {
  test("DEEPSEEK_MAIN_MODELS are official V4 ids and resolve to provider deepseek", () => {
    assert.deepEqual(
      [...DEEPSEEK_MAIN_MODELS],
      ["deepseek-v4-flash", "deepseek-v4-pro"],
    );
    assert.equal(providerForModel("deepseek-v4-flash"), "deepseek");
    assert.equal(providerForModel("deepseek-v4-pro"), "deepseek");
    assert.equal(
      resolveModel("deepseek-v4-flash", DEFAULT_MAIN_MODEL),
      "deepseek-v4-flash",
    );
    assert.equal(
      resolveModel("deepseek-v4-pro", DEFAULT_MAIN_MODEL),
      "deepseek-v4-pro",
    );
    assert.equal(DEFAULT_MAIN_MODEL, "claude-fable-5-1");
  });

  test("DeepSeek is not in the default chat fallback chain", () => {
    delete process.env.LLM_MODEL;
    delete process.env.LLM_FALLBACK_MODEL;
    delete process.env.LLM_PROVIDER;
    delete process.env.SAKANA_MODEL;
    const chain = resolveModelChain();
    assert.equal(
      chain.some((id) => id.startsWith("deepseek-")),
      false,
    );
    assert.deepEqual(chain, [
      "claude-fable-5-1",
      "claude-opus-5",
      "gpt-6-astra",
    ]);
  });

  test("DeepSeek is not a legal-council seat", () => {
    assert.equal(
      COUNCIL_MEMBERS.some((id) => id.startsWith("deepseek-")),
      false,
    );
    assert.equal(COUNCIL_MEMBERS.length, 5);
    assert.equal(COUNCIL_MEMBERS.includes("grok-4.6"), true);
  });

  test("DeepSeek client uses https://api.deepseek.com and DEEPSEEK_API_KEY", () => {
    delete process.env.DEEPSEEK_BASE_URL;
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    assert.equal(deepseekBaseUrl(), DEFAULT_DEEPSEEK_BASE_URL);
    assert.equal(DEFAULT_DEEPSEEK_BASE_URL, "https://api.deepseek.com");
    const client = deepseekClient();
    assert.equal(client.provider, "deepseek");
    assert.equal(client.baseUrl, "https://api.deepseek.com");
    assert.equal(client.apiKey, "test-deepseek-key");
    assert.equal(
      deepseekChatCompletionsUrl(client.baseUrl),
      "https://api.deepseek.com/chat/completions",
    );
  });

  test("deepseekClient throws when DEEPSEEK_API_KEY is missing", () => {
    delete process.env.DEEPSEEK_API_KEY;
    assert.throws(() => deepseekClient(), /DEEPSEEK_API_KEY/);
  });

  test("completeDeepSeekText posts deepseek-v4-flash to Chat Completions", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    delete process.env.DEEPSEEK_BASE_URL;
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
        { choices: [{ delta: { content: "deepseek " } }] },
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]);
    };

    try {
      const result = await completeDeepSeekText({
        model: "deepseek-v4-flash",
        user: "ping",
      });
      assert.equal(result, "deepseek ok");
      assert.equal(requestedUrl, "https://api.deepseek.com/chat/completions");
      assert.equal(requestBody?.model, "deepseek-v4-flash");
      assert.equal(requestBody?.stream, true);
      assert.deepEqual(requestBody?.thinking, { type: "disabled" });
      assert.equal(authHeader.startsWith("Bearer "), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
