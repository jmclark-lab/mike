import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorJobManager, readMikeSseText } from "../connectorJobs";

test("connector jobs start once and are polled idempotently", async () => {
  let calls = 0;
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const manager = new ConnectorJobManager(async () => {
    calls += 1;
    return pending;
  });

  assert.equal(manager.startOrGet("job-1", "Analyze").status, "working");
  assert.equal(manager.startOrGet("job-1", "Analyze").status, "working");
  assert.equal(calls, 1);

  finish("mandatory 4/4 opinion");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const done = manager.startOrGet("job-1", "Analyze");
  assert.equal(done.status, "done");
  if (done.status === "done") assert.equal(done.text, "mandatory 4/4 opinion");
  assert.equal(calls, 1);
});

test("connector jobs retain a terminal backend failure", async () => {
  const manager = new ConnectorJobManager(async () => {
    throw new Error("council quorum incomplete");
  });
  assert.equal(manager.startOrGet("job-2", "Analyze").status, "working");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failed = manager.startOrGet("job-2", "Analyze");
  assert.equal(failed.status, "error");
  if (failed.status === "error") {
    assert.match(failed.error, /quorum incomplete/);
  }
});

test("SSE reader joins visible Mike text and ignores heartbeats", async () => {
  const encoder = new TextEncoder();
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            ': keepalive\n\ndata: {"type":"content_delta","text":"four "}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"content_delta","text":"opinions"}\n\ndata: [DONE]\n\n',
          ),
        );
        controller.close();
      },
    }),
    { status: 200 },
  );

  assert.equal(await readMikeSseText(response), "four opinions");
});

test("SSE reader preserves a terminal Mike error", async () => {
  const response = new Response(
    'data: {"type":"error","message":"Council quorum incomplete"}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  await assert.rejects(readMikeSseText(response), /quorum incomplete/i);
});

test("SSE reader keeps a council synthesis even if the writer dies before DONE", async () => {
  const synthesis =
    "[Council: 3/4 opinions received (GPT-6 Astra, Gemini 3.1 Pro Preview, Grok 4.7); failed: Fable 5.1; reconciled by Opus 5.5]\n\nHold the send.";
  const response = new Response(
    `data: ${JSON.stringify({ type: "content_delta", text: synthesis })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  assert.equal(
    await readMikeSseText(response, "Convene the five-seat Council. min_quorum 3."),
    synthesis,
  );
});

test("SSE reader treats an abort error as failure when only a preamble was streamed", async () => {
  const response = new Response(
    'data: {"type":"content_delta","text":"I\'ll convene the five-seat Council. I\'m setting quorum at 3."}\n\ndata: {"type":"error","message":"Stream aborted."}\n\ndata: [DONE]\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  await assert.rejects(
    readMikeSseText(response, "Convene the five-seat Council. min_quorum 3."),
    /Stream aborted/,
  );
});

test("SSE reader keeps a council synthesis even if the writer then emits an abort error", async () => {
  const synthesis =
    "[Council: 3/4 opinions received (GPT-6 Astra, Gemini 3.1 Pro Preview, Grok 4.7); failed: Fable 5.1; reconciled by Opus 5.5]\n\nHold the send.";
  const response = new Response(
    `data: ${JSON.stringify({ type: "content_delta", text: synthesis })}\n\ndata: {"type":"error","message":"Stream aborted."}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  assert.equal(
    await readMikeSseText(response, "Convene the five-seat Council. min_quorum 3."),
    synthesis,
  );
});

test("SSE reader drops Gemini thought summaries and keeps the answer", async () => {
  // gemini-4-carbon sends includeThoughts. Thought parts become reasoning_delta
  // before this reader sees them; the answer is content_delta.
  const response = new Response(
    [
      'data: {"type":"reasoning_delta","text":"**Defining the MSA Concept**\\n\\nI\'m currently considering the master services agreement."}',
      'data: {"type":"reasoning_block_end"}',
      'data: {"type":"reasoning_delta","text":"**Checking the indemnity clause**\\n\\nThe cap looks mutual."}',
      'data: {"type":"reasoning_block_end"}',
      'data: {"type":"content_delta","text":"The indemnity is mutual."}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  assert.equal(await readMikeSseText(response), "The indemnity is mutual.");
});

test("SSE reader drops xAI reasoning summaries and keeps the answer", async () => {
  // streamXai reuses the OpenAI adapter. response.reasoning_summary_text.delta
  // is written as reasoning_delta; the answer is content_delta.
  const response = new Response(
    [
      'data: {"type":"reasoning_delta","text":"The notice clause is thirty days. Summarizing that before the answer."}',
      'data: {"type":"reasoning_block_end"}',
      'data: {"type":"content_delta","text":"Notice is thirty days."}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  assert.equal(await readMikeSseText(response), "Notice is thirty days.");
});

test("SSE reader ignores reasoning, thinking, and summary events", async () => {
  const response = new Response(
    [
      'data: {"type":"thinking","text":"anthropic thinking block"}',
      'data: {"type":"reasoning","text":"stored reasoning block"}',
      'data: {"type":"summary","text":"reasoning summary"}',
      'data: {"type":"reasoning_summary","text":"raw summary delta"}',
      'data: {"type":"content_delta","text":"Hello "}',
      'data: {"type":"reasoning_delta","text":"still thinking"}',
      'data: {"type":"content_delta","text":"world."}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  assert.equal(await readMikeSseText(response), "Hello world.");
});

test("a reasoning-only SSE stream is an empty answer and the job errors", async () => {
  const response = new Response(
    [
      'data: {"type":"reasoning_delta","text":"**Defining the MSA Concept**\\n\\nI\'m currently considering..."}',
      'data: {"type":"reasoning_block_end"}',
      'data: {"type":"reasoning_delta","text":"Still only thinking."}',
      "data: [DONE]",
      "",
    ].join("\n\n"),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  const text = await readMikeSseText(response);
  assert.equal(text, "");

  const manager = new ConnectorJobManager(async () => text);
  assert.equal(
    manager.startOrGet("job-reasoning-only", "What is an MSA?").status,
    "working",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failed = manager.startOrGet("job-reasoning-only", "What is an MSA?");
  assert.equal(failed.status, "error");
  if (failed.status === "error") {
    assert.match(failed.error, /empty response from Mike backend/);
  }
});

test("SSE reader does not treat a closed stream without DONE as a completed answer", async () => {
  const response = new Response(
    'data: {"type":"content_delta","text":"I\'ll convene the five-seat Council. I\'m setting quorum at 3."}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
  await assert.rejects(readMikeSseText(response), /without DONE/i);
});

test("connector jobs refuse a council intake preamble as the terminal answer", async () => {
  const preamble =
    "I'll convene the five-seat Council on the full v6.6 text. I'm setting quorum at 3 so a Fable seat failure does not suppress the judge synthesis.";
  const manager = new ConnectorJobManager(async () => preamble);
  assert.equal(
    manager.startOrGet(
      "job-preamble",
      "Convene the five-seat Council. min_quorum 3.",
    ).status,
    "working",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failed = manager.startOrGet(
    "job-preamble",
    "Convene the five-seat Council. min_quorum 3.",
  );
  assert.equal(failed.status, "error");
  if (failed.status === "error") {
    assert.match(failed.error, /intake preamble/i);
  }
});

test("connector jobs store the synthesis and drop a leading preamble", async () => {
  const synthesis =
    "[Council: 3/4 opinions received (GPT-6 Astra, Gemini 3.1 Pro Preview, Grok 4.7); failed: Fable 5.1; reconciled by Opus 5.5]\n\nHold the send.";
  const manager = new ConnectorJobManager(async () => {
    return `I'll convene the five-seat Council.\n\n${synthesis}`;
  });
  manager.startOrGet("job-synth", "Convene the five-seat Council. min_quorum 3.");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const done = manager.startOrGet(
    "job-synth",
    "Convene the five-seat Council. min_quorum 3.",
  );
  assert.equal(done.status, "done");
  if (done.status === "done") assert.equal(done.text, synthesis);
});
