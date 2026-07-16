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
