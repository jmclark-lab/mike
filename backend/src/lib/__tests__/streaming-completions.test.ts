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
    assert.deepEqual(requestBody?.reasoning, {
      effort: "xhigh",
      context: "all_turns",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI strict completion continues an incomplete reasoning response", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    if (requestBodies.length === 1) {
      return sseResponse([
        {
          type: "response.incomplete",
          response: {
            id: "resp_reasoning_budget",
            status: "incomplete",
            incomplete_details: { reason: "max_output_tokens" },
            output: [],
          },
        },
      ]);
    }
    return sseResponse([
      {
        type: "response.completed",
        response: {
          id: "resp_final",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "complete opinion" }],
            },
          ],
        },
      },
    ]);
  };

  try {
    const result = await completeOpenAIText({
      model: "gpt-5.6-sol",
      user: "Analyze",
      maxTokens: 16384,
      apiKeys: { openai: "test-openai-key" },
      reasoningEffort: "xhigh",
    });
    assert.equal(result, "complete opinion");
    assert.equal(requestBodies.length, 2);
    assert.equal(
      requestBodies[1].previous_response_id,
      "resp_reasoning_budget",
    );
    assert.match(
      JSON.stringify(requestBodies[1].input),
      /deliver the complete final opinion/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI strict completion fails explicitly after continuation budget is exhausted", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return sseResponse([
      {
        type: "response.incomplete",
        response: {
          id: `resp_incomplete_${calls}`,
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          output: [],
        },
      },
    ]);
  };

  try {
    await assert.rejects(
      completeOpenAIText({
        model: "gpt-5.6-sol",
        user: "Analyze",
        apiKeys: { openai: "test-openai-key" },
        reasoningEffort: "xhigh",
      }),
      /incomplete \(max_output_tokens.*after 2 continuation\(s\)/,
    );
    assert.equal(calls, 3);
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
