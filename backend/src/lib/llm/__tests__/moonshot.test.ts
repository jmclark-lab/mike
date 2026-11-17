import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { readMikeSseResult } from "../../connectorJobs";
import { COUNCIL_MEMBERS } from "../council";
import { completeTextStrict, resolveModelChain, streamChatWithTools } from "../index";
import {
  DEFAULT_MAIN_MODEL,
  MOONSHOT_MAIN_MODELS,
  isKimiK31ProEnabled,
  providerForModel,
  resolveModel,
} from "../models";
import {
  DEFAULT_MOONSHOT_BASE_URL,
  KIMI_K31_PRO_PROVIDER_ID,
  MOONSHOT_CN_BASE_URL,
  completeMoonshotText,
  moonshotChatCompletionsUrl,
  moonshotClient,
  moonshotProviderModelId,
  streamMoonshot,
} from "../moonshot";
import { isFencedModelId, isSponsorCiFencedModel } from "../../sponsorCiMode";
import { tokenPriceForModel } from "../pricing";

const saved = {
  kimi: process.env.KIMI_K31_PRO_ENABLED,
  key: process.env.MOONSHOT_API_KEY,
  sponsor: process.env.SPONSOR_CI_MODE,
  serp: process.env.SERP_SEARCH_MODE,
  llm: process.env.LLM_MODEL,
  fallback: process.env.LLM_FALLBACK_MODEL,
};

afterEach(() => {
  if (saved.kimi === undefined) delete process.env.KIMI_K31_PRO_ENABLED;
  else process.env.KIMI_K31_PRO_ENABLED = saved.kimi;
  if (saved.key === undefined) delete process.env.MOONSHOT_API_KEY;
  else process.env.MOONSHOT_API_KEY = saved.key;
  if (saved.sponsor === undefined) delete process.env.SPONSOR_CI_MODE;
  else process.env.SPONSOR_CI_MODE = saved.sponsor;
  if (saved.serp === undefined) delete process.env.SERP_SEARCH_MODE;
  else process.env.SERP_SEARCH_MODE = saved.serp;
  if (saved.llm === undefined) delete process.env.LLM_MODEL;
  else process.env.LLM_MODEL = saved.llm;
  if (saved.fallback === undefined) delete process.env.LLM_FALLBACK_MODEL;
  else process.env.LLM_FALLBACK_MODEL = saved.fallback;
});

const DEFAULT_CHAIN = [
  "gemini-4-carbon",
  "grok-4.7",
  "nvidia/nemotron-3-ultra-550b-a55b",
];

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const payload = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(encoder.encode(payload), { status: 200 });
}

describe("Kimi K3.1 Pro selectable-only wiring", { concurrency: false }, () => {
  test("the flag defaults off and the id is not selectable or on the council", () => {
    delete process.env.KIMI_K31_PRO_ENABLED;
    assert.equal(isKimiK31ProEnabled({}), false);
    for (const value of ["1", "yes", "on", "TRUE", "True", "false"]) {
      assert.equal(
        isKimiK31ProEnabled({ KIMI_K31_PRO_ENABLED: value } as NodeJS.ProcessEnv),
        false,
        value,
      );
    }
    assert.equal(
      isKimiK31ProEnabled({ KIMI_K31_PRO_ENABLED: " true " } as NodeJS.ProcessEnv),
      true,
    );
    assert.deepEqual([...MOONSHOT_MAIN_MODELS], ["kimi-k3.1-pro"]);
    assert.equal(providerForModel("kimi-k3.1-pro"), "moonshot");
    assert.equal(
      resolveModel("kimi-k3.1-pro", DEFAULT_MAIN_MODEL, {}),
      DEFAULT_MAIN_MODEL,
    );
    assert.equal(
      COUNCIL_MEMBERS.some((id) => id.startsWith("kimi-")),
      false,
    );
    assert.deepEqual(resolveModelChain({}), DEFAULT_CHAIN);
    assert.equal(tokenPriceForModel("kimi-k3.1-pro")?.inputUsdPerMillion, 2);
    assert.equal(tokenPriceForModel("kimi-k3.1-pro")?.outputUsdPerMillion, 10);
  });

  test("the public alias maps to the verified provider id", () => {
    assert.equal(moonshotProviderModelId("kimi-k3.1-pro"), KIMI_K31_PRO_PROVIDER_ID);
    assert.equal(moonshotProviderModelId(" Kimi-K3.1-Pro "), KIMI_K31_PRO_PROVIDER_ID);
    assert.equal(KIMI_K31_PRO_PROVIDER_ID, "kimi-k3.1-pro");
    assert.equal(DEFAULT_MOONSHOT_BASE_URL, "https://api.moonshot.ai/v1");
    assert.equal(MOONSHOT_CN_BASE_URL, "https://api.moonshot.cn/v1");
    assert.notEqual(DEFAULT_MOONSHOT_BASE_URL, MOONSHOT_CN_BASE_URL);
  });

  test("Sponsor-CI fences kimi the same way it fences DeepSeek", () => {
    const env = {
      KIMI_K31_PRO_ENABLED: "true",
      SPONSOR_CI_MODE: "1",
    } as NodeJS.ProcessEnv;
    assert.equal(isFencedModelId("kimi-k3.1-pro"), true);
    assert.equal(isSponsorCiFencedModel("kimi-k3.1-pro", env), true);
    assert.equal(
      resolveModel("kimi-k3.1-pro", DEFAULT_MAIN_MODEL, env),
      DEFAULT_MAIN_MODEL,
    );
    assert.deepEqual(resolveModelChain(env), DEFAULT_CHAIN);
  });

  test("flag on still leaves the default chain and council unchanged", () => {
    const env = { KIMI_K31_PRO_ENABLED: "true" } as NodeJS.ProcessEnv;
    assert.equal(
      resolveModel("kimi-k3.1-pro", DEFAULT_MAIN_MODEL, env),
      "kimi-k3.1-pro",
    );
    assert.deepEqual(resolveModelChain(env), DEFAULT_CHAIN);
    assert.equal(
      COUNCIL_MEMBERS.some((id) => id === "kimi-k3.1-pro"),
      false,
    );
  });

  test("naming kimi in LLM_MODEL or LLM_FALLBACK_MODEL does not add it to the chain", () => {
    const env = {
      KIMI_K31_PRO_ENABLED: "true",
      LLM_MODEL: "kimi-k3.1-pro",
      LLM_FALLBACK_MODEL: "kimi-k3.1-pro,grok-4.7",
    } as NodeJS.ProcessEnv;
    const chain = resolveModelChain(env);
    assert.equal(chain.some((id) => id.startsWith("kimi-")), false);
    assert.equal(chain[0], "gemini-4-carbon");
    assert.equal(chain.includes("grok-4.7"), true);
  });

  test("a disabled kimi pin is rejected and does not fall back", async () => {
    delete process.env.KIMI_K31_PRO_ENABLED;
    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    delete process.env.SPONSOR_CI_MODE;
    process.env.SERP_SEARCH_MODE = "off";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network should not be called");
    };
    try {
      await assert.rejects(
        () => completeTextStrict({ model: "kimi-k3.1-pro", user: "hello" }),
        /switched off \(kimi-k3\.1-pro\)/,
      );
      await assert.rejects(
        () =>
          streamChatWithTools({
            model: "kimi-k3.1-pro",
            strictModel: true,
            systemPrompt: "Answer.",
            messages: [{ role: "user", content: "hello" }],
          }),
        /Model kimi-k3\.1-pro failed with no fallback: .*switched off/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a missing Moonshot key rejects the pin and does not fall back", async () => {
    process.env.KIMI_K31_PRO_ENABLED = "true";
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.SPONSOR_CI_MODE;
    process.env.SERP_SEARCH_MODE = "off";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network should not be called");
    };
    try {
      assert.throws(() => moonshotClient(), /MOONSHOT_API_KEY/);
      await assert.rejects(
        () => completeTextStrict({ model: "kimi-k3.1-pro", user: "hello" }),
        /requires MOONSHOT_API_KEY/,
      );
      await assert.rejects(
        () =>
          streamChatWithTools({
            model: "kimi-k3.1-pro",
            strictModel: true,
            systemPrompt: "Answer.",
            messages: [{ role: "user", content: "hello" }],
          }),
        /Model kimi-k3\.1-pro failed with no fallback: .*MOONSHOT_API_KEY/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("completeMoonshotText posts the verified id and maps medium to high", async () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return sseResponse([
        { model: KIMI_K31_PRO_PROVIDER_ID, choices: [{ delta: { reasoning_content: "think" } }] },
        { model: KIMI_K31_PRO_PROVIDER_ID, choices: [{ delta: { content: "kimi " } }] },
        { model: KIMI_K31_PRO_PROVIDER_ID, choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]);
    };
    try {
      const result = await completeMoonshotText({
        model: "kimi-k3.1-pro",
        user: "ping",
        effort: "medium",
      });
      assert.equal(result, "kimi ok");
      assert.equal(result.includes("think"), false);
      assert.equal(
        requestedUrl,
        moonshotChatCompletionsUrl(DEFAULT_MOONSHOT_BASE_URL),
      );
      assert.equal(requestBody?.model, KIMI_K31_PRO_PROVIDER_ID);
      assert.equal(requestBody?.reasoning_effort, "high");
      assert.equal(requestBody?.temperature, undefined);
      assert.equal(requestBody?.top_p, undefined);
      assert.equal(requestBody?.max_tokens, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reasoning deltas are classified as reasoning and stay out of the answer", async () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    const originalFetch = globalThis.fetch;
    const reasoning: string[] = [];
    let reasoningClosed = false;
    const content: string[] = [];
    globalThis.fetch = async () =>
      sseResponse([
        {
          id: "chatcmpl-kimi",
          model: KIMI_K31_PRO_PROVIDER_ID,
          choices: [{ delta: { reasoning_content: "hidden indemnity thought" } }],
        },
        {
          model: KIMI_K31_PRO_PROVIDER_ID,
          choices: [{ delta: { reasoning_content: " still thinking" } }],
        },
        {
          model: KIMI_K31_PRO_PROVIDER_ID,
          choices: [{ delta: { content: "The clause is mutual." }, finish_reason: "stop" }],
        },
      ]);
    try {
      const result = await streamMoonshot({
        model: "kimi-k3.1-pro",
        systemPrompt: "Answer.",
        messages: [{ role: "user", content: "Review the clause." }],
        effort: "high",
        callbacks: {
          onReasoningDelta: (text) => reasoning.push(text),
          onReasoningBlockEnd: () => {
            reasoningClosed = true;
          },
          onContentDelta: (text) => content.push(text),
        },
      });
      assert.deepEqual(reasoning, ["hidden indemnity thought", " still thinking"]);
      assert.equal(reasoningClosed, true);
      assert.deepEqual(content, ["The clause is mutual."]);
      assert.equal(result.fullText, "The clause is mutual.");
      assert.equal(result.fullText.includes("hidden indemnity"), false);
      assert.equal(result.providerMetadata?.provider_name, "moonshot");
      assert.equal(result.providerMetadata?.model_name, KIMI_K31_PRO_PROVIDER_ID);

      const connector = await readMikeSseResult(
        new Response(
          [
            'data: {"type":"reasoning_delta","text":"hidden indemnity thought still thinking"}',
            'data: {"type":"reasoning_block_end"}',
            'data: {"type":"content_delta","text":"The clause is mutual."}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
        "Review the clause.",
        { pinnedModel: true },
      );
      assert.equal(connector.text, "The clause is mutual.");
      assert.equal(connector.text.includes("hidden indemnity"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test(
    "live pin reports the verified Moonshot model id",
    {
      skip:
        process.env.KIMI_K31_PRO_ENABLED === "true" &&
        Boolean(process.env.MOONSHOT_API_KEY?.trim())
          ? false
          : "set KIMI_K31_PRO_ENABLED=true and MOONSHOT_API_KEY to run the live pin",
      timeout: 120_000,
    },
    async () => {
      const key = process.env.MOONSHOT_API_KEY ?? "";
      const redact = (err: unknown): Error => {
        const message = err instanceof Error ? err.message : String(err);
        return new Error(key ? message.split(key).join("[redacted]") : message);
      };
      let result;
      try {
        result = await streamMoonshot({
          model: "kimi-k3.1-pro",
          systemPrompt: "Reply with exactly the word pong.",
          messages: [{ role: "user", content: "ping" }],
          effort: "low",
        });
      } catch (err) {
        throw redact(err);
      }
      assert.equal(result.providerMetadata?.provider_name, "moonshot");
      assert.equal(result.providerMetadata?.model_name, KIMI_K31_PRO_PROVIDER_ID);
      assert.equal(result.fullText.trim().length > 0, true);
      assert.equal(result.fullText.includes(key), false);
    },
  );
});
