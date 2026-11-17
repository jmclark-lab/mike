import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicOutputEffort,
  geminiThinkingLevel,
  kimiMaxCompletionTokens,
  kimiReasoningEffort,
  nvidiaEnableThinking,
  openAIMaxOutputTokens,
  openAIReasoningEffort,
  xaiMaxOutputTokens,
  xaiReasoningEffort,
} from "../effort";
import { buildClaudeMessageParams, buildGeminiRequestConfig, buildKimiChatBody, buildOpenAIResponsesBody } from "../requestParams";
import { thinkingBody, nvidiaOutputTokens } from "../nvidia";
import { resolveModelChain } from "../index";

const EFFORTS = ["low", "medium", "high", "max"] as const;

test("unpinned chain starts with gemini-4-carbon and has no Claude or OpenAI", () => {
  const chain = resolveModelChain({});
  assert.deepEqual(chain, [
    "gemini-4-carbon",
    "grok-4.7",
    "nvidia/nemotron-3-ultra-550b-a55b",
  ]);
  assert.equal(chain.some((id) => id.startsWith("claude") || id.startsWith("gpt-") || id.startsWith("kimi-")), false);
});

test("gemini-4-carbon request payloads map effort onto thinking_level", () => {
  const omitted = buildGeminiRequestConfig({
    model: "gemini-4-carbon",
    streaming: true,
    enableThinking: true,
    applyThinkingConfig: true,
    thinkingLevel: geminiThinkingLevel("gemini-4-carbon"),
  });
  assert.equal((omitted.thinkingConfig as { thinkingLevel: string }).thinkingLevel, "high");
  assert.equal(omitted.maxOutputTokens, 32768);
  assert.equal((omitted.thinkingConfig as { thinkingBudget?: number }).thinkingBudget, undefined);

  const expected = { low: "low", medium: "medium", high: "high", max: "high" } as const;
  for (const effort of EFFORTS) {
    const level = geminiThinkingLevel("gemini-4-carbon", effort);
    const body = buildGeminiRequestConfig({
      model: "gemini-4-carbon",
      streaming: false,
      enableThinking: true,
      applyThinkingConfig: true,
      thinkingLevel: level,
      maxTokens: 4096,
    });
    assert.equal((body.thinkingConfig as { thinkingLevel: string }).thinkingLevel, expected[effort], effort);
    assert.equal(body.maxOutputTokens, effort === "low" || effort === "medium" ? 4096 : 32768, effort);
  }
});

test("grok-4.7 request effort maps onto reasoning.effort xhigh at the top", () => {
  assert.equal(xaiReasoningEffort("grok-4.7"), "xhigh");
  assert.equal(xaiMaxOutputTokens("grok-4.7", "xhigh"), 32768);
  assert.equal(xaiMaxOutputTokens("grok-4.7", "xhigh", 8000), 32768);
  const expected = { low: "low", medium: "medium", high: "high", max: "xhigh" } as const;
  for (const effort of EFFORTS) {
    const reasoningEffort = xaiReasoningEffort("grok-4.7", effort);
    const body = buildOpenAIResponsesBody({
      model: "grok-4.7",
      input: "Review the clause.",
      maxTokens: xaiMaxOutputTokens("grok-4.7", reasoningEffort, 8000),
      reasoningEffort,
    });
    assert.equal((body.reasoning as { effort: string }).effort, expected[effort], effort);
    if (effort === "max") assert.equal(body.max_output_tokens, 32768);
  }
});

test("Claude request payloads map effort onto output_config.effort", () => {
  const omitted = buildClaudeMessageParams({
    model: "claude-fable-5-2",
    max_tokens: 32000,
    messages: [{ role: "user", content: "Review." }],
    enableThinking: true,
  });
  assert.equal((omitted.output_config as { effort: string }).effort, "high");
  assert.equal((omitted.thinking as { type: string }).type, "adaptive");

  for (const effort of EFFORTS) {
    const body = buildClaudeMessageParams({
      model: "claude-opus-5-5",
      max_tokens: effort === "max" ? 128000 : 32000,
      messages: [{ role: "user", content: "Review." }],
      effort: anthropicOutputEffort(effort),
    });
    assert.equal((body.output_config as { effort: string }).effort, effort, effort);
    assert.equal((body.thinking as { type: string }).type, "adaptive", effort);
    if (effort === "max") assert.equal(body.max_tokens, 128000);
  }
});

test("OpenAI request payloads map effort, and gpt-6.1-sol max stays max", () => {
  const omitted = buildOpenAIResponsesBody({
    model: "gpt-6-astra",
    input: "Review.",
    maxTokens: openAIMaxOutputTokens(undefined),
    reasoningSummary: true,
  });
  assert.equal((omitted.reasoning as { effort?: string }).effort, undefined);
  assert.equal(omitted.max_output_tokens, 16384);

  const astraMax = openAIReasoningEffort("gpt-6-astra", "max");
  const astraBody = buildOpenAIResponsesBody({
    model: "gpt-6-astra",
    input: "Review.",
    maxTokens: openAIMaxOutputTokens("max"),
    reasoningEffort: astraMax,
  });
  assert.equal((astraBody.reasoning as { effort: string }).effort, "xhigh");
  assert.equal(astraBody.max_output_tokens, 32768);

  const solMax = openAIReasoningEffort("gpt-6.1-sol", "max");
  const solBody = buildOpenAIResponsesBody({
    model: "gpt-6.1-sol",
    input: "Review.",
    maxTokens: openAIMaxOutputTokens("max"),
    reasoningEffort: solMax,
  });
  assert.equal((solBody.reasoning as { effort: string }).effort, "max");
  assert.equal(solBody.max_output_tokens, 32768);

  for (const effort of ["low", "medium", "high"] as const) {
    const body = buildOpenAIResponsesBody({
      model: "gpt-6-astra",
      input: "Review.",
      maxTokens: openAIMaxOutputTokens(effort),
      reasoningEffort: openAIReasoningEffort("gpt-6-astra", effort),
    });
    assert.equal((body.reasoning as { effort: string }).effort, effort, effort);
  }
});

test("NVIDIA request payloads map effort onto enable_thinking and keep a thinking budget", () => {
  assert.deepEqual(thinkingBody(), { chat_template_kwargs: { enable_thinking: true } });
  assert.equal(nvidiaEnableThinking(), true);
  assert.equal(nvidiaEnableThinking("low"), false);
  assert.deepEqual(thinkingBody("low"), { chat_template_kwargs: { enable_thinking: false } });
  for (const effort of ["medium", "high", "max"] as const) {
    assert.equal(thinkingBody(effort).chat_template_kwargs.enable_thinking, true, effort);
  }
  assert.equal(nvidiaOutputTokens(1000, "high"), 16384);
  assert.equal(nvidiaOutputTokens(1000, "max"), 16384);
  assert.equal(nvidiaOutputTokens(), 16384);
});

test("kimi-k3.1-pro maps effort onto reasoning_effort and has no medium", () => {
  assert.equal(kimiReasoningEffort(), undefined);
  assert.equal(kimiReasoningEffort("low"), "low");
  assert.equal(kimiReasoningEffort("medium"), "high");
  assert.equal(kimiReasoningEffort("high"), "high");
  assert.equal(kimiReasoningEffort("max"), "max");
  assert.equal(kimiMaxCompletionTokens("low"), 16384);
  assert.equal(kimiMaxCompletionTokens("max"), 32768);
  const body = buildKimiChatBody({
    model: "kimi-k3.1-pro",
    messages: [{ role: "user", content: "Hello" }],
    maxTokens: kimiMaxCompletionTokens("medium"),
    reasoningEffort: kimiReasoningEffort("medium"),
  });
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.thinking, undefined);
  assert.equal(body.max_completion_tokens, 32768);
});
