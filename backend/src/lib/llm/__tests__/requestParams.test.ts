import assert from "node:assert/strict";
import test from "node:test";
import {
  GEMINI_4_ARGON_MIN_OUTPUT_TOKENS,
  GEMINI_4_ARGON_STREAM_OUTPUT_TOKENS,
  GEMINI_4_ARGON_TIMEOUT_MS,
  buildClaudeMessageParams,
  buildGeminiRequestConfig,
  buildKimiChatBody,
  buildOpenAIResponsesBody,
  geminiClientTimeoutMs,
  openAIPersistedReasoningContext,
} from "../requestParams";

const FORBIDDEN_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "topP",
  "topK",
  "budget_tokens",
  "cachedContent",
  "cached_content",
];

function assertAbsent(body: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, key), false, key);
  }
}

test("Sonnet 5.5 and Haiku 5.5 requests drop sampling, budgets, and prefill", () => {
  for (const model of ["claude-sonnet-5-5", "claude-haiku-5-5"]) {
    const body = buildClaudeMessageParams({
      model,
      max_tokens: 1024,
      system: "Be brief.",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Prefill" },
      ],
      enableThinking: true,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      thinking: { type: "enabled", budget_tokens: 8000 },
    });
    assertAbsent(body, ["temperature", "top_p", "top_k", "budget_tokens"]);
    const thinking = body.thinking as Record<string, unknown> | undefined;
    assert.equal(thinking, undefined);
    const messages = body.messages as Array<{ role: string }>;
    assert.equal(messages.at(-1)?.role, "user");
    assert.equal(
      messages.some((message) => message.role === "assistant"),
      false,
    );
  }
});

test("older Claude models still accept an assistant prefill in the builder", () => {
  const body = buildClaudeMessageParams({
    model: "claude-haiku-4-5",
    max_tokens: 256,
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Cont" },
    ],
    temperature: 0,
  });
  const messages = body.messages as Array<{ role: string }>;
  assert.equal(messages.at(-1)?.role, "assistant");
  assert.equal(body.temperature, 0);
});

test("Gemini 4 Argon config has no sampling, cache, or sub-32k cap", () => {
  const config = buildGeminiRequestConfig({
    model: "gemini-4-argon",
    streaming: false,
    systemInstruction: "sys",
    maxTokens: 16000,
    enableThinking: false,
    applyThinkingConfig: true,
    extra: {
      temperature: 0.4,
      topP: 0.9,
      top_p: 0.9,
      topK: 20,
      candidateCount: 2,
      cachedContent: "cachedContents/abc",
      cached_content: "cachedContents/abc",
    },
  });
  assertAbsent(config, FORBIDDEN_KEYS);
  assert.ok(
    (config.maxOutputTokens as number) >= GEMINI_4_ARGON_MIN_OUTPUT_TOKENS,
  );
  assert.equal(config.maxOutputTokens, GEMINI_4_ARGON_MIN_OUTPUT_TOKENS);
  assert.equal(config.thinkingConfig, undefined);
  assert.equal(geminiClientTimeoutMs("gemini-4-argon"), GEMINI_4_ARGON_TIMEOUT_MS);
  assert.equal(geminiClientTimeoutMs("gemini-3.5-flash"), undefined);

  const streamed = buildGeminiRequestConfig({
    model: "gemini-4-argon",
    streaming: true,
    enableThinking: true,
    applyThinkingConfig: true,
  });
  assert.equal(streamed.maxOutputTokens, GEMINI_4_ARGON_STREAM_OUTPUT_TOKENS);
  assert.equal(
    (streamed.thinkingConfig as { thinkingLevel?: string }).thinkingLevel,
    "medium",
  );
  assert.equal(
    (streamed.thinkingConfig as { thinkingBudget?: number }).thinkingBudget,
    undefined,
  );
});

test("other Gemini models keep the thinking budget the chat path already sent", () => {
  const config = buildGeminiRequestConfig({
    model: "gemini-3.5-flash",
    streaming: true,
    enableThinking: false,
    applyThinkingConfig: true,
    extra: { temperature: 0.2 },
  });
  assert.equal(
    (config.thinkingConfig as { thinkingBudget?: number }).thinkingBudget,
    0,
  );
  assert.equal(config.temperature, 0.2);
  assert.equal(config.maxOutputTokens, undefined);
});

test("gpt-6.1-sol drops sampling and logprobs and remaps none/minimal to low", () => {
  const body = buildOpenAIResponsesBody({
    model: "gpt-6.1-sol",
    input: "Hello",
    maxTokens: 1024,
    reasoningEffort: "none",
    reasoningContext: openAIPersistedReasoningContext("gpt-6.1-sol"),
    temperature: 0.5,
    top_p: 1,
    top_logprobs: 3,
    logprobs: true,
    include: ["message.output_text.logprobs", "reasoning.encrypted_content"],
  });
  assertAbsent(body, ["temperature", "top_p", "top_logprobs", "logprobs"]);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(
    (body.reasoning as { effort?: string }).effort,
    "low",
  );
  assert.equal(
    (body.reasoning as { context?: string }).context,
    "all_turns",
  );

  const minimal = buildOpenAIResponsesBody({
    model: "gpt-6.1-sol",
    input: "Hello",
    maxTokens: 1024,
    reasoningEffort: "minimal",
  });
  assert.equal((minimal.reasoning as { effort?: string }).effort, "low");
});

test("kimi-k3.1-pro chat body omits Moonshot's fixed sampling params", () => {
  const body = buildKimiChatBody({
    model: "kimi-k3.1-pro",
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: 256,
    stream: true,
    temperature: 1,
    top_p: 0.95,
    n: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
  });
  assertAbsent(body, [
    "temperature",
    "top_p",
    "n",
    "presence_penalty",
    "frequency_penalty",
  ]);
  assert.equal(body.model, "kimi-k3.1-pro");
  assert.equal(body.stream, true);
});

test("gpt-6-sol stays on the legacy body, including reasoning effort none", () => {
  const body = buildOpenAIResponsesBody({
    model: "gpt-6-sol",
    input: "Hello",
    maxTokens: 512,
    reasoningEffort: "none",
    reasoningContext: openAIPersistedReasoningContext("gpt-6-sol"),
    temperature: 0.3,
  });
  assert.equal(body.temperature, 0.3);
  assert.equal((body.reasoning as { effort?: string }).effort, "none");
  assert.equal(openAIPersistedReasoningContext("gpt-6-astra"), "all_turns");
});
