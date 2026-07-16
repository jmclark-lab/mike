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
  assert.ok(JSON.stringify(first).length < 20000);
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
