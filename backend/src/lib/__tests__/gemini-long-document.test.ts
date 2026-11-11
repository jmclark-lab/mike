import assert from "node:assert/strict";
import test from "node:test";
import { GEMINI_4_CARBON_MAX_OUTPUT_TOKENS } from "../llm/requestParams";
import {
  geminiChatMaxOutputTokens,
  geminiChatTurnFailure,
  shouldContinueGeminiLongDocument,
  streamGemini,
} from "../llm/gemini";

test("Gemini 4 Carbon chat output stays clamped at 32768", () => {
  assert.equal(
    geminiChatMaxOutputTokens("gemini-4-carbon", true),
    GEMINI_4_CARBON_MAX_OUTPUT_TOKENS,
  );
  assert.equal(GEMINI_4_CARBON_MAX_OUTPUT_TOKENS, 32768);
  assert.equal(
    geminiChatMaxOutputTokens("gemini-4-carbon", false),
    32768,
  );
});

test("a long Gemini document continues on MAX_TOKENS and then stops", () => {
  assert.equal(
    shouldContinueGeminiLongDocument({
      longDocument: true,
      finishReason: "MAX_TOKENS",
      toolCallCount: 0,
      continuationsUsed: 0,
      partCount: 1,
    }),
    true,
  );
  assert.equal(
    shouldContinueGeminiLongDocument({
      longDocument: true,
      finishReason: "MAX_TOKENS",
      toolCallCount: 0,
      continuationsUsed: 2,
      partCount: 1,
    }),
    false,
  );
  assert.equal(
    shouldContinueGeminiLongDocument({
      longDocument: false,
      finishReason: "MAX_TOKENS",
      toolCallCount: 0,
      continuationsUsed: 0,
      partCount: 1,
    }),
    false,
  );
  assert.match(
    geminiChatTurnFailure("MAX_TOKENS", 0, 32768) ?? "",
    /maxOutputTokens=32768/,
  );
});

test("a long Gemini 4 Carbon review continues under the 32768 clamp", async () => {
  const calls: Array<{ config?: { maxOutputTokens?: number; systemInstruction?: string }; contents: unknown[] }> = [];
  async function* first() {
    yield {
      candidates: [
        {
          finishReason: "MAX_TOKENS",
          content: { parts: [{ text: "AAA" }] },
        },
      ],
    };
  }
  async function* second() {
    yield {
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: "BBB" }] },
        },
      ],
    };
  }
  const streams = [first(), second()];
  const result = await streamGemini(
    {
      model: "gemini-4-carbon",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "c".repeat(20_000) }],
    },
    {
      generate: async (request) => {
        calls.push(request);
        const next = streams.shift();
        if (!next) throw new Error("unexpected extra Gemini call");
        return next;
      },
    },
  );
  assert.equal(result.fullText, "AAABBB");
  assert.equal(result.providerMetadata?.model_name, "gemini-4-carbon");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.config?.maxOutputTokens, 32768);
  assert.equal(calls[1]?.config?.maxOutputTokens, 32768);
  assert.match(calls[0]?.config?.systemInstruction ?? "", /LONG DOCUMENT/);
  const continued = calls[1]?.contents as Array<{ role?: string }>;
  assert.equal(continued[continued.length - 1]?.role, "user");
  assert.equal(continued[continued.length - 2]?.role, "model");
});
