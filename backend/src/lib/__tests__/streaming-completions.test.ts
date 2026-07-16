import assert from "node:assert/strict";
import test from "node:test";
import { completeOpenAIText } from "../llm/openai";
import { completeSakanaText } from "../llm/sakana";

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(
    new ReadableStream({
      start(controller) {
        // Split the payload so parsers are exercised across transport chunks.
        const midpoint = Math.floor(body.length / 2);
        controller.enqueue(encoder.encode(body.slice(0, midpoint)));
        controller.enqueue(encoder.encode(body.slice(midpoint)));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

test("OpenAI strict completion uses streaming transport and joins deltas", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return sseResponse([
      { type: "response.output_text.delta", delta: "council " },
      { type: "response.output_text.delta", delta: "opinion" },
      {
        type: "response.completed",
        response: { status: "completed", output_text: "council opinion" },
      },
    ]);
  };

  try {
    const result = await completeOpenAIText({
      model: "gpt-5.6-sol",
      user: "Analyze",
      apiKeys: { openai: "test-openai-key" },
      reasoningEffort: "xhigh",
    });
    assert.equal(result, "council opinion");
    assert.equal(requestBody?.stream, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Sakana strict completion uses streaming transport and joins deltas", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return sseResponse([
      { choices: [{ delta: { content: "Fugu " }, finish_reason: null }] },
      { choices: [{ delta: { content: "opinion" }, finish_reason: "stop" }] },
    ]);
  };

  try {
    const result = await completeSakanaText({
      model: "fugu-ultra-20260615",
      user: "Analyze",
      apiKeys: { sakana: "test-sakana-key" },
    });
    assert.equal(result, "Fugu opinion");
    assert.equal(requestBody?.stream, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
