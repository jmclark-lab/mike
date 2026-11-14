import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { parseConnectorModelChoice } from "../../connectorModelChoice";
import {
  COUNCIL_JUDGE,
  COUNCIL_MEMBERS,
  conveneCouncilWithCompleter,
  resolveCouncilJudge,
  resolveCouncilSeats,
} from "../council";
import { chatModelsForRequest, resolveModelChain } from "../index";
import {
  DEFAULT_MAIN_MODEL,
  NVIDIA_MAIN_MODELS,
  isNvidiaModelId,
  providerForModel,
  resolveModel,
} from "../models";
import {
  DEFAULT_NVIDIA_BASE_URL,
  DEFAULT_NVIDIA_MODEL,
  completeNvidiaText,
  nvidiaBaseUrl,
  nvidiaChatCompletionsUrl,
  nvidiaClient,
  streamNvidia,
} from "../nvidia";

const NVIDIA_ENV_KEYS = [
  "NVIDIA_API_KEY",
  "NVIDIA_BASE_URL",
  "NVIDIA_MODEL",
  "LLM_MODEL",
  "LLM_FALLBACK_MODEL",
  "SPONSOR_CI_MODE",
] as const;
const saved = new Map<string, string | undefined>();
for (const key of NVIDIA_ENV_KEYS) saved.set(key, process.env[key]);

function restoreNvidiaEnv() {
  for (const key of NVIDIA_ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreNvidiaEnv);

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

function installFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response) {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
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
  const headers = init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return "";
  const value = (headers as Record<string, string>)[name];
  return typeof value === "string" ? value : "";
}

describe("NVIDIA Nemotron selectable chat model", { concurrency: false }, () => {
  test("the id resolves to provider nvidia and is not a council seat", () => {
    assert.deepEqual([...NVIDIA_MAIN_MODELS], [DEFAULT_NVIDIA_MODEL]);
    assert.equal(providerForModel(DEFAULT_NVIDIA_MODEL), "nvidia");
    assert.equal(resolveModel(DEFAULT_NVIDIA_MODEL, DEFAULT_MAIN_MODEL), DEFAULT_NVIDIA_MODEL);
    assert.equal(isNvidiaModelId("nemotron"), true);
    assert.equal(isNvidiaModelId("NVIDIA"), true);
    assert.equal(
      COUNCIL_MEMBERS.some((id) => isNvidiaModelId(id)),
      false,
    );
    assert.equal(COUNCIL_MEMBERS.length, 4);
    assert.deepEqual(COUNCIL_MEMBERS, [
      "claude-fable-5-2",
      "gpt-6-astra",
      "gemini-4-carbon",
      "grok-4.7",
    ]);
  });

  test("Nemotron is absent from the default chain and from council selection", () => {
    delete process.env.LLM_MODEL;
    delete process.env.LLM_FALLBACK_MODEL;
    delete process.env.SPONSOR_CI_MODE;
    const chain = resolveModelChain();
    assert.equal(chain.some((id) => isNvidiaModelId(id)), false);
    assert.deepEqual(chain, [
      "claude-fable-5-2",
      "claude-opus-5-5",
      "gpt-6-astra",
    ]);

    const seats = resolveCouncilSeats({
      COUNCIL_ANTHROPIC_MODEL: "nemotron",
      COUNCIL_OPENAI_MODEL: DEFAULT_NVIDIA_MODEL,
      COUNCIL_GEMINI_MODEL: "NVIDIA",
      COUNCIL_XAI_MODEL: "nvidia/nemotron-3-ultra-550b-a55b",
      COUNCIL_JUDGE: "nemotron",
    });
    assert.deepEqual(
      seats.map((seat) => seat.model),
      [...COUNCIL_MEMBERS],
    );
    assert.equal(
      resolveCouncilJudge({ COUNCIL_JUDGE: DEFAULT_NVIDIA_MODEL }),
      COUNCIL_JUDGE,
    );
  });

  test("a pinned Nemotron request does not fall back, and an LLM_MODEL override keeps the existing tail", () => {
    const pinned = chatModelsForRequest({
      strictModel: true,
      model: DEFAULT_NVIDIA_MODEL,
    });
    assert.equal(pinned.strict, true);
    assert.deepEqual(pinned.models, [DEFAULT_NVIDIA_MODEL]);

    assert.deepEqual(
      resolveModelChain({ LLM_MODEL: DEFAULT_NVIDIA_MODEL }),
      [DEFAULT_NVIDIA_MODEL, "claude-opus-5-5", "gpt-6-astra"],
    );
    assert.equal(
      resolveModelChain({
        SPONSOR_CI_MODE: "1",
        NODE_ENV: "test",
        LLM_MODEL: DEFAULT_NVIDIA_MODEL,
      }).some((id) => isNvidiaModelId(id)),
      false,
    );
  });

  test("ask_mike aliases nemotron and nvidia resolve to the canonical id", () => {
    for (const alias of ["nemotron", "NVIDIA", "Nvidia", DEFAULT_NVIDIA_MODEL]) {
      assert.deepEqual(parseConnectorModelChoice(alias), {
        ok: true,
        model: DEFAULT_NVIDIA_MODEL,
        provider: "nvidia",
      });
    }
  });

  test("an injected Nemotron seat is replaced before the council calls a model", async () => {
    const previous = process.env.SPONSOR_CI_MODE;
    delete process.env.SPONSOR_CI_MODE;
    const invoked: string[] = [];
    try {
      await conveneCouncilWithCompleter(
        { question: "Review this matter." },
        async ({ model }) => {
          invoked.push(model);
          return "Answer";
        },
        {
          retryBaseDelayMs: 0,
          sleepFn: async () => undefined,
          seats: [
            {
              provider: "anthropic",
              model: "claude-fable-5-2",
              label: "Fable 5.2",
              maxTokens: 1000,
            },
            {
              provider: "openai",
              model: "gpt-6-astra",
              label: "GPT-6 Astra",
              maxTokens: 1000,
            },
            {
              provider: "google",
              model: "gemini-4-carbon",
              label: "Gemini 4 Carbon",
              maxTokens: 1000,
            },
            {
              provider: "xai",
              model: DEFAULT_NVIDIA_MODEL,
              label: "Nemotron",
              maxTokens: 1000,
            },
          ],
        },
      );
    } finally {
      if (previous === undefined) delete process.env.SPONSOR_CI_MODE;
      else process.env.SPONSOR_CI_MODE = previous;
    }
    assert.equal(invoked.includes(DEFAULT_NVIDIA_MODEL), false);
    assert.equal(invoked.includes("grok-4.7"), true);
    assert.equal(invoked.includes(COUNCIL_JUDGE), true);
  });

  test("client defaults and a missing key never call fetch", async () => {
    delete process.env.NVIDIA_BASE_URL;
    delete process.env.NVIDIA_API_KEY;
    assert.equal(nvidiaBaseUrl(), DEFAULT_NVIDIA_BASE_URL);
    assert.equal(DEFAULT_NVIDIA_BASE_URL, "https://integrate.api.nvidia.com/v1");
    assert.throws(() => nvidiaClient(), /NVIDIA_API_KEY/);

    const fetchMock = installFetch(() => {
      throw new Error("network should not be called");
    });
    try {
      await assert.rejects(
        () => completeNvidiaText({ model: DEFAULT_NVIDIA_MODEL, user: "ping" }),
        /NVIDIA_API_KEY/,
      );
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
    }
  });

  test("completeNvidiaText posts Chat Completions with enable_thinking and drops reasoning", async () => {
    process.env.NVIDIA_API_KEY = "test-nvidia-key";
    delete process.env.NVIDIA_BASE_URL;
    delete process.env.NVIDIA_MODEL;
    const fetchMock = installFetch(() =>
      sseResponse([
        {
          id: "chatcmpl-nemotron",
          choices: [{ delta: { reasoning_content: "hidden thought" } }],
        },
        { choices: [{ delta: { reasoning: "also hidden" } }] },
        { choices: [{ delta: { content: "visible " } }] },
        { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] },
      ]),
    );
    try {
      const result = await completeNvidiaText({
        model: DEFAULT_NVIDIA_MODEL,
        user: "ping",
      });
      assert.equal(result, "visible answer");
      assert.equal(result.includes("hidden"), false);
      const call = fetchMock.calls[0];
      assert.ok(call);
      assert.equal(
        call.url,
        "https://integrate.api.nvidia.com/v1/chat/completions",
      );
      assert.equal(call.url.includes("/responses"), false);
      assert.equal(call.url.toLowerCase().includes("openrouter"), false);
      assert.equal(header(call.init, "Authorization"), "Bearer test-nvidia-key");
      assert.equal(header(call.init, "Content-Type"), "application/json");
      const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      assert.equal(body.model, DEFAULT_NVIDIA_MODEL);
      assert.equal(body.stream, true);
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
      assert.equal(
        nvidiaChatCompletionsUrl(nvidiaClient().baseUrl),
        "https://integrate.api.nvidia.com/v1/chat/completions",
      );
    } finally {
      fetchMock.restore();
    }
  });

  test("NVIDIA_BASE_URL and NVIDIA_MODEL override the request, and stream keeps reasoning off the answer", async () => {
    process.env.NVIDIA_API_KEY = "test-nvidia-key";
    process.env.NVIDIA_BASE_URL = "https://example.test/nvidia/v1/";
    process.env.NVIDIA_MODEL = "nvidia/nemotron-override";
    const reasoning: string[] = [];
    const content: string[] = [];
    const fetchMock = installFetch(() =>
      sseResponse([
        { choices: [{ delta: { reasoning_content: "think" } }] },
        {
          id: "chatcmpl-stream",
          choices: [{ delta: { content: "shown" }, finish_reason: "stop" }],
        },
      ]),
    );
    try {
      const result = await streamNvidia({
        model: DEFAULT_NVIDIA_MODEL,
        systemPrompt: "system",
        messages: [{ role: "user", content: "ping" }],
        callbacks: {
          onReasoningDelta: (text) => reasoning.push(text),
          onContentDelta: (text) => content.push(text),
        },
      });
      assert.equal(result.fullText, "shown");
      assert.deepEqual(reasoning, ["think"]);
      assert.deepEqual(content, ["shown"]);
      assert.equal(result.providerMetadata?.provider_name, "nvidia");
      assert.equal(result.providerMetadata?.model_name, "nvidia/nemotron-override");
      const call = fetchMock.calls[0];
      assert.ok(call);
      assert.equal(call.url, "https://example.test/nvidia/v1/chat/completions");
      const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>;
      assert.equal(body.model, "nvidia/nemotron-override");
      assert.deepEqual(body.chat_template_kwargs, { enable_thinking: true });
    } finally {
      fetchMock.restore();
    }
  });

  test("a JSON chat completion ignores reasoning_content on the message", async () => {
    process.env.NVIDIA_API_KEY = "test-nvidia-key";
    delete process.env.NVIDIA_BASE_URL;
    delete process.env.NVIDIA_MODEL;
    const fetchMock = installFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "json answer",
                  reasoning_content: "json thought",
                },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    try {
      const result = await completeNvidiaText({
        model: DEFAULT_NVIDIA_MODEL,
        user: "ping",
      });
      assert.equal(result, "json answer");
    } finally {
      fetchMock.restore();
    }
  });

  test("HTTP failures and aborts surface the same wording the fallback classifier uses", async () => {
    process.env.NVIDIA_API_KEY = "test-nvidia-key";
    delete process.env.NVIDIA_BASE_URL;
    const failure = installFetch(
      () => new Response("upstream timed out", { status: 503, statusText: "Service Unavailable" }),
    );
    try {
      await assert.rejects(
        () => completeNvidiaText({ model: DEFAULT_NVIDIA_MODEL, user: "ping" }),
        /NVIDIA request failed \(503\): upstream timed out/,
      );
    } finally {
      failure.restore();
    }

    const aborted = new AbortController();
    aborted.abort();
    const fetchMock = installFetch(() => {
      throw new Error("network should not be called");
    });
    try {
      await assert.rejects(
        () =>
          streamNvidia({
            model: DEFAULT_NVIDIA_MODEL,
            systemPrompt: "system",
            messages: [{ role: "user", content: "ping" }],
            abortSignal: aborted.signal,
          }),
        /Stream aborted\./,
      );
      assert.equal(fetchMock.calls.length, 0);
    } finally {
      fetchMock.restore();
    }
  });
});
