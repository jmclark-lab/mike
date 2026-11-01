import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { COUNCIL_MEMBERS } from "../council";
import { completeTextStrict, resolveModelChain } from "../index";
import {
  DEFAULT_MAIN_MODEL,
  MOONSHOT_MAIN_MODELS,
  isKimiK31ProEnabled,
  providerForModel,
  resolveModel,
} from "../models";
import {
  DEFAULT_MOONSHOT_BASE_URL,
  completeMoonshotText,
  moonshotChatCompletionsUrl,
  moonshotClient,
} from "../moonshot";
import { isFencedModelId, isSponsorCiFencedModel } from "../../sponsorCiMode";
import { tokenPriceForModel } from "../pricing";

const saved = {
  kimi: process.env.KIMI_K31_PRO_ENABLED,
  key: process.env.MOONSHOT_API_KEY,
  sponsor: process.env.SPONSOR_CI_MODE,
};

afterEach(() => {
  if (saved.kimi === undefined) delete process.env.KIMI_K31_PRO_ENABLED;
  else process.env.KIMI_K31_PRO_ENABLED = saved.kimi;
  if (saved.key === undefined) delete process.env.MOONSHOT_API_KEY;
  else process.env.MOONSHOT_API_KEY = saved.key;
  if (saved.sponsor === undefined) delete process.env.SPONSOR_CI_MODE;
  else process.env.SPONSOR_CI_MODE = saved.sponsor;
});

describe("Kimi K3.1 Pro selectable-only wiring", { concurrency: false }, () => {
  test("the flag defaults off and the id is not selectable or on the council", () => {
    delete process.env.KIMI_K31_PRO_ENABLED;
    assert.equal(isKimiK31ProEnabled({}), false);
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
    assert.equal(
      resolveModelChain({}).some((id) => id.startsWith("kimi-")),
      false,
    );
    assert.equal(tokenPriceForModel("kimi-k3.1-pro")?.inputUsdPerMillion, 2);
    assert.equal(tokenPriceForModel("kimi-k3.1-pro")?.outputUsdPerMillion, 10);
  });

  test("Sponsor-CI fences kimi the same way it fences DeepSeek", () => {
    const env = {
      KIMI_K31_PRO_ENABLED: "1",
      SPONSOR_CI_MODE: "1",
    } as NodeJS.ProcessEnv;
    assert.equal(isFencedModelId("kimi-k3.1-pro"), true);
    assert.equal(isSponsorCiFencedModel("kimi-k3.1-pro", env), true);
    assert.equal(
      resolveModel("kimi-k3.1-pro", DEFAULT_MAIN_MODEL, env),
      DEFAULT_MAIN_MODEL,
    );
    assert.equal(
      resolveModelChain(env).some((id) => id.startsWith("kimi-")),
      false,
    );
  });

  test("flag on and Sponsor-CI off lets resolveModel return kimi, still not the chain or council", () => {
    const env = { KIMI_K31_PRO_ENABLED: "1" } as NodeJS.ProcessEnv;
    assert.equal(
      resolveModel("kimi-k3.1-pro", DEFAULT_MAIN_MODEL, env),
      "kimi-k3.1-pro",
    );
    assert.deepEqual(resolveModelChain(env), [
      "claude-fable-5-1",
      "claude-opus-5-5",
      "gpt-6-astra",
    ]);
  });

  test("a disabled kimi id is refused before any network call", async () => {
    delete process.env.KIMI_K31_PRO_ENABLED;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.SPONSOR_CI_MODE;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network should not be called");
    };
    try {
      await assert.rejects(
        () => completeTextStrict({ model: "kimi-k3.1-pro", user: "hello" }),
        /Kimi is disabled \(kimi-k3\.1-pro\)/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("moonshotClient throws when no key is wired", () => {
    delete process.env.MOONSHOT_API_KEY;
    assert.throws(() => moonshotClient(), /no key wired/);
  });

  test("completeMoonshotText posts kimi-k3.1-pro without fixed sampling params", async () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = async (input, init) => {
      requestedUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      const encoder = new TextEncoder();
      const payload = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "kimi " } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`,
      ].join("");
      return new Response(encoder.encode(payload), { status: 200 });
    };
    try {
      const result = await completeMoonshotText({
        model: "kimi-k3.1-pro",
        user: "ping",
      });
      assert.equal(result, "kimi ok");
      assert.equal(
        requestedUrl,
        moonshotChatCompletionsUrl(DEFAULT_MOONSHOT_BASE_URL),
      );
      assert.equal(DEFAULT_MOONSHOT_BASE_URL, "https://api.moonshot.ai/v1");
      assert.equal(requestBody?.model, "kimi-k3.1-pro");
      assert.equal(requestBody?.temperature, undefined);
      assert.equal(requestBody?.top_p, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
