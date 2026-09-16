import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8");
const workerModule = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

class MemoryStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
    this.alarm = null;
  }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async deleteAll() { this.values.clear(); }
  async list() { return new Map(this.values); }
  async setAlarm(value) { this.alarm = value; }
}

class MemoryR2 {
  constructor() {
    this.objects = new Map();
  }
  async put(key, value) {
    let bytes;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value.slice(0));
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    else bytes = new TextEncoder().encode(String(value));
    this.objects.set(key, bytes);
  }
  async get(key) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      async text() { return new TextDecoder().decode(bytes); },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
    };
  }
  async delete(key) {
    this.objects.delete(key);
  }
}

function state(initial) {
  return { storage: new MemoryStorage(initial) };
}

async function rpc(env, method, params = {}) {
  const response = await workerModule.default.fetch(
    new Request("https://mike.test/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    env,
  );
  return response.json();
}

test("tools expose bounded multipart output schemas and accurate annotations", async () => {
  const listed = await rpc({ MCP_API_KEY: "test-key" }, "tools/list");
  const byName = Object.fromEntries(listed.result.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(Object.keys(byName.get_mike_answer.inputSchema.properties), ["job_id", "part"]);
  assert.equal(byName.get_mike_answer.annotations.readOnlyHint, true);
  assert.equal(byName.get_mike_answer.annotations.destructiveHint, false);
  assert.equal(byName.ask_mike.annotations.destructiveHint, false);
  assert.equal(byName.ask_mike.inputSchema.properties.prompt.maxLength, 500000);
  assert.match(byName.ask_mike.inputSchema.properties.prompt.description, /UTF-8 byte chunks under 128 KiB/i);
  assert.match(source, /version: "1\.8\.2"/);
  assert.match(source, /MCP connector v1\.8\.2/);
  assert.match(source, /PROMPT_CHUNK_BYTES = 100 \* 1024/);
  assert.match(source, /MCP_MAX_BODY_BYTES = 2 \* 1024 \* 1024/);
  assert.match(source, /refusing to complete with intake preamble/);
  assert.equal(byName.get_mike_answer.outputSchema.properties.total_parts.type, "integer");
});

test("get_mike_answer returns one bounded part for a large completed result", async () => {
  const full = "x".repeat(182766);
  const chunks = Array.from({ length: Math.ceil(full.length / 15000) }, (_, index) =>
    full.slice(index * 15000, (index + 1) * 15000),
  );
  const fakeJob = {
    fetch: async (request) => {
      const url = new URL(typeof request === "string" ? request : request.url);
      const part = Number(url.searchParams.get("part") || "1");
      return new Response(JSON.stringify({
        status: "done",
        text: chunks[part - 1],
        part,
        totalParts: chunks.length,
        elapsed: 300,
      }));
    },
  };
  const env = {
    MCP_API_KEY: "test-key",
    MIKE_JOBS: { idFromName: (id) => id, get: () => fakeJob },
  };

  const first = await rpc(env, "tools/call", {
    name: "get_mike_answer",
    arguments: { job_id: "job", part: 1 },
  });

  assert.equal(first.result.structuredContent.total_parts, 13);
  assert.equal(first.result.structuredContent.text, undefined);
  const answer = first.result.content[0].text.split("\n\n")[1];
  assert.equal(answer.length, 15000);
  assert.equal(answer, "x".repeat(15000));
  // content + structuredContent.answer both carry the 15k part (~30k JSON total)
  assert.ok(JSON.stringify(first).length < 40000);
  assert.ok(JSON.stringify(first).length < full.length);
  assert.match(first.result.content[0].text, /part 1 of 13/);
});

test("jobs are readable only by the principal that created them", async () => {
  const jobState = state({
    job: { status: "done", principal: "principal-a", created: Date.now(), totalParts: 1 },
    "result:1": "confidential answer",
  });
  const job = new workerModule.MikeJob(jobState, {});

  const denied = await job.fetch(new Request("https://do/status?part=1", {
    headers: { "x-mike-principal": "principal-b" },
  }));
  assert.equal(denied.status, 403);

  const allowed = await job.fetch(new Request("https://do/status?part=1", {
    headers: { "x-mike-principal": "principal-a" },
  }));
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).text, "confidential answer");
});

test("stale working jobs are finalized instead of remaining stuck forever", async () => {
  const jobState = state({
    job: {
      status: "working",
      principal: "principal-a",
      prompt: "confidential prompt",
      created: Date.now() - 5000,
      startedAt: Date.now() - 5000,
    },
  });
  const job = new workerModule.MikeJob(jobState, { MAX_JOB_AGE_MS: "1000" });

  const response = await job.fetch(new Request("https://do/status", {
    headers: { "x-mike-principal": "principal-a" },
  }));
  const payload = await response.json();
  const stored = await jobState.storage.get("job");

  assert.equal(payload.status, "error");
  assert.match(payload.error, /maximum job age/i);
  assert.equal(stored.status, "error");
  assert.equal(stored.prompt, null);
});

test("long jobs are polled by stable backend id without duplicating execution", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  let calls = 0;
  globalThis.fetch = async (input) => {
    calls += 1;
    urls.push(String(input));
    const payload = calls < 3
      ? { status: "working" }
      : { status: "done", text: "mandatory 4/4 opinion" };
    return new Response(JSON.stringify(payload), {
      status: calls < 3 ? 202 : 200,
      headers: { "content-type": "application/json" },
    });
  };
  const jobState = state({
    job: {
      status: "working",
      principal: "principal-a",
      prompt: "Analyze",
      created: Date.now(),
      startedAt: Date.now(),
    },
  });
  const job = new workerModule.MikeJob(jobState, {
    MIKE_BACKEND_URL: "https://backend.test",
    CONNECTOR_API_KEY: "test-key",
    RETRY_DELAY_MS: "1",
  });

  try {
    await job.alarm();
    const first = await jobState.storage.get("job");
    assert.equal(first.status, "working");
    assert.equal(first.attempt, 1);
    assert.ok(first.backendJobId);
    assert.ok(jobState.storage.alarm);

    await job.alarm();
    const second = await jobState.storage.get("job");
    assert.equal(second.status, "working");
    assert.equal(second.backendJobId, first.backendJobId);

    await job.alarm();
    const done = await jobState.storage.get("job");
    assert.equal(done.status, "done");
    assert.equal(done.attempt, 1);
    assert.equal(await jobState.storage.get("result:1"), "mandatory 4/4 opinion");
    assert.equal(calls, 3);
    assert.ok(urls.every((url) => url.endsWith("/connector/jobs/" + first.backendJobId)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MikeJob refuses an intake preamble as the terminal council answer", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "done",
    text: "I'll convene the five-seat Council on the full v6.6 text. I'm setting quorum at 3.",
  }), { status: 200, headers: { "content-type": "application/json" } });
  const jobState = state({
    job: {
      status: "working",
      principal: "principal-a",
      prompt: "Convene the five-seat Council on this PTA. min_quorum 3.",
      created: Date.now(),
      startedAt: Date.now(),
    },
  });
  const job = new workerModule.MikeJob(jobState, {
    MIKE_BACKEND_URL: "https://backend.test",
    CONNECTOR_API_KEY: "test-key",
    RETRY_DELAY_MS: "1",
  });
  try {
    await job.alarm();
    const stored = await jobState.storage.get("job");
    assert.equal(stored.status, "error");
    assert.match(stored.error, /intake preamble/i);
    assert.equal(await jobState.storage.get("result:1"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MikeJob stores synthesis and drops a leading intake preamble", async () => {
  const originalFetch = globalThis.fetch;
  const synthesis = "[Council: 3/5 opinions received (Fugu Ultra, GPT-6 Astra, Grok 4.6); failed: Fable 5.1, Gemini 3.1 Pro Preview; reconciled by Opus 5]\n\nHold the send.";
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: "done",
    text: "I'll convene the five-seat Council.\n\n" + synthesis,
  }), { status: 200, headers: { "content-type": "application/json" } });
  const jobState = state({
    job: {
      status: "working",
      principal: "principal-a",
      prompt: "Convene the five-seat Council. min_quorum 3.",
      created: Date.now(),
      startedAt: Date.now(),
    },
  });
  const job = new workerModule.MikeJob(jobState, {
    MIKE_BACKEND_URL: "https://backend.test",
    CONNECTOR_API_KEY: "test-key",
    RETRY_DELAY_MS: "1",
  });
  try {
    await job.alarm();
    const stored = await jobState.storage.get("job");
    assert.equal(stored.status, "done");
    assert.equal(stored.answerSource, "synthesis");
    assert.equal(await jobState.storage.get("result:1"), synthesis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function chunkByteLength(part) {
  if (part == null) return 0;
  if (typeof part === "string") return new TextEncoder().encode(part).length;
  if (part instanceof ArrayBuffer) return part.byteLength;
  if (ArrayBuffer.isView(part)) return part.byteLength;
  return 0;
}

test("MikeJob chunks large ASCII prompts and alarm reassembles them for callMike", async () => {
  const originalFetch = globalThis.fetch;
  let receivedPrompt = null;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init.body);
    receivedPrompt = body.prompt;
    return new Response(JSON.stringify({ status: "done", text: "chunked prompt ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const jobState = state();
  const job = new workerModule.MikeJob(jobState, {
    MIKE_BACKEND_URL: "https://backend.test",
    CONNECTOR_API_KEY: "test-key",
    RETRY_DELAY_MS: "1",
  });
  const bigPrompt = "p".repeat(200000);
  try {
    const started = await job.fetch(new Request("https://do/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: bigPrompt,
        principal: "principal-a",
        jobId: "job-large-prompt",
      }),
    }));
    assert.equal(started.status, 200);
    const meta = await jobState.storage.get("job");
    assert.equal(meta.prompt, null);
    assert.equal(meta.promptR2Key, null);
    assert.ok(meta.promptChunks >= 2);
    let totalBytes = 0;
    for (let i = 0; i < meta.promptChunks; i++) {
      const chunk = await jobState.storage.get("prompt:" + i);
      assert.ok(chunk instanceof ArrayBuffer);
      assert.ok(chunk.byteLength <= 128 * 1024);
      totalBytes += chunk.byteLength;
    }
    assert.equal(totalBytes, 200000);

    await job.alarm();
    assert.equal(receivedPrompt, bigPrompt);
    const done = await jobState.storage.get("job");
    assert.equal(done.status, "done");
    assert.equal(done.prompt, null);
    assert.equal(done.promptChunks, 0);
    assert.equal(await jobState.storage.get("prompt:0"), undefined);
    assert.equal(await jobState.storage.get("result:1"), "chunked prompt ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MikeJob DO fallback splits multibyte prompts by UTF-8 bytes under 128 KiB", async () => {
  const originalFetch = globalThis.fetch;
  let receivedPrompt = null;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init.body);
    receivedPrompt = body.prompt;
    return new Response(JSON.stringify({ status: "done", text: "multibyte ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const jobState = state();
  const job = new workerModule.MikeJob(jobState, {
    MIKE_BACKEND_URL: "https://backend.test",
    CONNECTOR_API_KEY: "test-key",
    RETRY_DELAY_MS: "1",
  });
  const bigPrompt = "á".repeat(90000);
  const utf8Bytes = new TextEncoder().encode(bigPrompt).length;
  assert.ok(utf8Bytes > 128 * 1024, "fixture must exceed DO 128 KiB as a single value");
  try {
    const started = await job.fetch(new Request("https://do/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: bigPrompt,
        principal: "principal-a",
        jobId: "job-multibyte-prompt",
      }),
    }));
    assert.equal(started.status, 200);
    const meta = await jobState.storage.get("job");
    assert.equal(meta.prompt, null);
    assert.equal(meta.promptR2Key, null);
    assert.ok(meta.promptChunks >= 2);
    let totalBytes = 0;
    for (let i = 0; i < meta.promptChunks; i++) {
      const chunk = await jobState.storage.get("prompt:" + i);
      assert.ok(chunk instanceof ArrayBuffer);
      assert.ok(chunkByteLength(chunk) <= 128 * 1024);
      totalBytes += chunkByteLength(chunk);
    }
    assert.equal(totalBytes, utf8Bytes);

    await job.alarm();
    assert.equal(receivedPrompt, bigPrompt);
    const done = await jobState.storage.get("job");
    assert.equal(done.status, "done");
    assert.equal(done.promptChunks, 0);
    assert.equal(await jobState.storage.get("prompt:0"), undefined);
    assert.equal(await jobState.storage.get("result:1"), "multibyte ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MikeJob stores prompts in R2 when MIKE_PROMPTS is bound", async () => {
  const originalFetch = globalThis.fetch;
  let receivedPrompt = null;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(init.body);
    receivedPrompt = body.prompt;
    return new Response(JSON.stringify({ status: "done", text: "r2 ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const r2 = new MemoryR2();
  const jobState = state();
  const job = new workerModule.MikeJob(jobState, {
    MIKE_BACKEND_URL: "https://backend.test",
    CONNECTOR_API_KEY: "test-key",
    RETRY_DELAY_MS: "1",
    MIKE_PROMPTS: r2,
  });
  const bigPrompt = "á".repeat(90000);
  try {
    const started = await job.fetch(new Request("https://do/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: bigPrompt,
        principal: "principal-a",
        jobId: "job-r2-prompt",
      }),
    }));
    assert.equal(started.status, 200);
    const meta = await jobState.storage.get("job");
    assert.equal(meta.prompt, null);
    assert.equal(meta.promptChunks, 0);
    assert.equal(meta.promptR2Key, "mcp-prompts/job-r2-prompt.txt");
    assert.equal(await jobState.storage.get("prompt:0"), undefined);
    const stored = await r2.get(meta.promptR2Key);
    assert.ok(stored);
    assert.equal(await stored.text(), bigPrompt);

    await job.alarm();
    assert.equal(receivedPrompt, bigPrompt);
    const done = await jobState.storage.get("job");
    assert.equal(done.status, "done");
    assert.equal(done.promptR2Key, null);
    assert.equal(await r2.get("mcp-prompts/job-r2-prompt.txt"), null);
    assert.equal(await jobState.storage.get("result:1"), "r2 ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth authorization codes are single-use and access tokens expire independently of the API key", async () => {
  const authState = state();
  const auth = new workerModule.MikeAuth(authState);
  const call = async (path, body) => auth.fetch(new Request("https://auth" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  const registration = await (await call("/register", {
    redirect_uris: ["https://chatgpt.com/connector/callback"],
  })).json();
  const verifier = "a".repeat(64);
  const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(challengeBytes).toString("base64url");
  const authorization = await (await call("/authorize", {
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uris[0],
    code_challenge: challenge,
    principal: "principal-a",
  })).json();

  const exchangeBody = {
    grant_type: "authorization_code",
    code: authorization.code,
    code_verifier: verifier,
    client_id: registration.client_id,
    redirect_uri: registration.redirect_uris[0],
  };
  const firstExchange = await call("/token", exchangeBody);
  assert.equal(firstExchange.status, 200);
  const tokens = await firstExchange.json();
  assert.match(tokens.access_token, /^mike_at_/);
  assert.notEqual(tokens.access_token, "test-key");

  const replay = await call("/token", exchangeBody);
  assert.equal(replay.status, 400);

  const validation = await call("/validate", { access_token: tokens.access_token });
  assert.equal(validation.status, 200);
  assert.equal((await validation.json()).principal, "principal-a");
});
