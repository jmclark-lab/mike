var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js — fugu-assistant MCP connector
// TIMEOUT FIX (v1.6.0): the ask_fugu_ultra deep-reasoning path (FuguJob.alarm)
// used a flat 90s hard abort on a NON-streaming request, for a model that takes
// 10–30 min — so every attempt aborted at 90s. Switched that path to a STREAMING
// request with an idle-based abort (90s of silence) + 20-min absolute ceiling,
// with a JSON fallback if the API ignores stream. The fast ask_fugu path is
// unchanged (30s is fine for quick answers).
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
__name(json, "json");
async function checkSakanaHealth() {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 8e3);
    const r = await fetch("https://api.sakana.ai/v1/models", {
      signal: controller.signal
    });
    clearTimeout(tid);
    const latency = Date.now() - start;
    return {
      status: "up",
      latency_ms: latency,
      http_status: r.status,
      checked_at: (/* @__PURE__ */ new Date()).toISOString()
    };
  } catch (e) {
    const latency = Date.now() - start;
    const msg = e && e.message || "unknown";
    return {
      status: "down",
      latency_ms: latency,
      error: msg.slice(0, 200),
      checked_at: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
}
__name(checkSakanaHealth, "checkSakanaHealth");
async function callSakana(env, model, messages, stream) {
  const body = { model, messages, stream: !!stream };
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 3e4);
  let r;
  try {
    r = await fetch("https://api.sakana.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + env.SAKANA_API_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(tid);
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Sakana API " + r.status + ": " + t.slice(0, 300));
  }
  return r;
}
__name(callSakana, "callSakana");
async function callSakanaSync(env, model, messages) {
  const r = await callSakana(env, model, messages, false);
  const d = await r.json();
  return d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || "(no content returned)";
}
__name(callSakanaSync, "callSakanaSync");
// Streaming deep call with idle-based abort. Resets the abort timer on every
// chunk received, so a long-but-progressing generation runs up to maxMs; a
// stalled connection aborts after idleMs. Falls back to JSON parsing if the API
// responds without an event-stream.
async function callFuguUltraStream(env, messages, opts) {
  const idleMs = (opts && opts.idleMs) || 9e4;
  const maxMs = (opts && opts.maxMs) || 12e5;
  const controller = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleMs);
  };
  const hardTimer = setTimeout(() => controller.abort(), maxMs);
  try {
    armIdle();
    const r = await fetch("https://api.sakana.ai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + env.SAKANA_API_KEY },
      body: JSON.stringify({ model: "fugu-ultra", messages, stream: true }),
      signal: controller.signal
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error("Sakana API " + r.status + ": " + t.slice(0, 300));
    }
    const ctype = (r.headers.get("content-type") || "").toLowerCase();
    if (!ctype.includes("event-stream")) {
      // API ignored stream: rely on the hard cap only, parse as JSON.
      if (idleTimer) clearTimeout(idleTimer);
      const d = await r.json();
      return d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content || "";
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "", text = "";
    while (true) {
      const rr = await reader.read();
      if (rr.done) break;
      armIdle();
      buf += dec.decode(rr.value, { stream: true });
      const parts = buf.split("\n");
      buf = parts.pop();
      for (const l of parts) {
        const line = l.trim();
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (d === "[DONE]" || d === "") continue;
        try {
          const o = JSON.parse(d);
          const ch = o.choices && o.choices[0];
          const piece = ch && ((ch.delta && ch.delta.content) || (ch.message && ch.message.content));
          if (piece) text += piece;
        } catch (e) {
        }
      }
    }
    return text || "";
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(hardTimer);
  }
}
__name(callFuguUltraStream, "callFuguUltraStream");
async function toBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
__name(toBase64url, "toBase64url");
async function sha256base64url(input) {
  const enc = new TextEncoder();
  const hash = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toBase64url(hash);
}
__name(sha256base64url, "sha256base64url");
async function computeAuthCode(secret, codeChallenge) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode("authcode:" + codeChallenge));
  return toBase64url(sig);
}
__name(computeAuthCode, "computeAuthCode");
function oauthAuthPage(redirectUri, state, codeChallenge) {
  const esc = /* @__PURE__ */ __name((s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;"), "esc");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fugu Ultra Assistant — Authorize</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,sans-serif;background:#f5f5f5;margin:0;
       display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.1);
        padding:36px 32px;width:100%;max-width:380px}
  .logo{font-size:2rem;margin-bottom:12px}
  h1{font-size:1.1rem;margin:0 0 6px;color:#1a2b2c}
  p{color:#6b7a7a;font-size:.875rem;margin:0 0 22px}
  label{display:block;font-size:.8rem;font-weight:600;color:#1a2b2c;margin-bottom:6px}
  input[type=password]{width:100%;padding:10px 12px;border:1px solid #e2e6e6;border-radius:8px;
                        font-size:1rem;outline:none;transition:border-color .15s}
  input[type=password]:focus{border-color:#6B4FBB;box-shadow:0 0 0 3px rgba(107,79,187,.12)}
  button{display:block;width:100%;margin-top:16px;background:#6B4FBB;color:#fff;border:0;
         border-radius:8px;padding:11px;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#5a3fa8}
</style>
</head>
<body>
<div class="card">
  <div class="logo">\u{1F421}</div>
  <h1>Connect to Fugu Ultra Assistant</h1>
  <p>Enter the MCP API key to authorize this connection.</p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="redirect_uri" value="${esc(encodeURIComponent(redirectUri))}">
    <input type="hidden" name="state" value="${esc(encodeURIComponent(state))}">
    <input type="hidden" name="code_challenge" value="${esc(encodeURIComponent(codeChallenge))}">
    <label for="api_key">MCP API Key</label>
    <input type="password" id="api_key" name="api_key" placeholder="Paste your MCP API key" autofocus required>
    <button type="submit">Authorize</button>
  </form>
</div>
</body>
</html>`;
}
__name(oauthAuthPage, "oauthAuthPage");
function chatPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fugu Ultra Assistant</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,-apple-system,sans-serif;background:#1a1a2e;color:#eee;
       display:flex;flex-direction:column;height:100vh}
  header{padding:16px 24px;background:#16213e;border-bottom:1px solid #0f3460;
         display:flex;align-items:center;gap:12px}
  header h1{font-size:1.1rem;color:#e94560}
  #chat{flex:1;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:16px}
  .msg{max-width:80%;padding:12px 16px;border-radius:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
  .user{align-self:flex-end;background:#0f3460;color:#eee}
  .assistant{align-self:flex-start;background:#16213e;color:#eee;border:1px solid #0f3460}
  .thinking{color:#888;font-style:italic;font-size:.85rem}
  form{display:flex;gap:10px;padding:16px 24px;background:#16213e;border-top:1px solid #0f3460}
  textarea{flex:1;background:#1a1a2e;border:1px solid #0f3460;color:#eee;border-radius:8px;
           padding:10px 14px;font-size:1rem;resize:none;outline:none;min-height:48px;max-height:160px}
  textarea:focus{border-color:#e94560}
  button[type=submit]{background:#e94560;color:#fff;border:0;border-radius:8px;
                      padding:0 20px;font-size:1rem;font-weight:600;cursor:pointer;min-width:80px}
  button:disabled{opacity:.5;cursor:default}
  #model-select{background:#1a1a2e;border:1px solid #0f3460;color:#eee;border-radius:6px;
                padding:4px 8px;font-size:.85rem}
</style>
</head>
<body>
<header>
  <span style="font-size:1.5rem">\u{1F421}</span>
  <h1>Fugu Ultra Assistant</h1>
  <select id="model-select">
    <option value="fugu">Fugu (fast)</option>
    <option value="fugu-ultra">Fugu Ultra (deep)</option>
  </select>
</header>
<div id="chat"></div>
<form id="form">
  <textarea id="input" placeholder="Ask anything…" rows="1"></textarea>
  <button type="submit" id="send">Send</button>
</form>
<script>
const chat = document.getElementById('chat');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');
const modelSelect = document.getElementById('model-select');
let history = [];
let passphrase = null;

async function getPassphrase() {
  if (passphrase) return passphrase;
  const p = prompt('Enter passphrase:');
  if (!p) throw new Error('No passphrase');
  passphrase = p;
  return p;
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  div.textContent = text;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

function addThinking() {
  const div = document.createElement('div');
  div.className = 'msg assistant thinking';
  div.textContent = 'Fugu is thinking…';
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  send.disabled = true;

  addMsg('user', text);
  history.push({ role: 'user', content: text });
  const thinking = addThinking();

  try {
    const pp = await getPassphrase();
    const model = modelSelect.value;
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-passphrase': pp },
      body: JSON.stringify({ messages: history, model }),
    });
    if (r.status === 401) { passphrase = null; thinking.remove(); alert('Wrong passphrase.'); send.disabled = false; return; }
    if (!r.ok) { thinking.remove(); addMsg('assistant', 'Error: ' + r.status); send.disabled = false; return; }
    const data = await r.json();
    const reply = data.content || '(no content)';
    thinking.remove();
    addMsg('assistant', reply);
    history.push({ role: 'assistant', content: reply });
  } catch(err) {
    thinking.remove();
    addMsg('assistant', 'Error: ' + err.message);
  }
  send.disabled = false;
  input.focus();
});
<\/script>
</body>
</html>`;
}
__name(chatPage, "chatPage");
var worker_default = {
  // Cron job — runs every 15 minutes, writes Sakana health to KV
  async scheduled(event, env, ctx) {
    const result = await checkSakanaHealth();
    if (env.HEALTH_KV) {
      await env.HEALTH_KV.put("fugu_health", JSON.stringify(result), {
        expirationTtl: 3600
      });
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Fugu Ultra Assistant — MCP connector v1.6.0.", {
        headers: { "content-type": "text/plain" }
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      let result = null;
      if (env.HEALTH_KV) {
        const raw = await env.HEALTH_KV.get("fugu_health");
        if (raw) {
          result = JSON.parse(raw);
          result.cached = true;
        }
      }
      if (!result) {
        result = await checkSakanaHealth();
        result.cached = false;
      }
      const httpStatus = result.status === "up" ? 200 : 503;
      return json(result, httpStatus);
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: url.origin,
        authorization_endpoint: url.origin + "/oauth/authorize",
        token_endpoint: url.origin + "/oauth/token",
        registration_endpoint: url.origin + "/oauth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (url.pathname === "/oauth/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return json(
        {
          client_id: "fugu-client-" + crypto.randomUUID().slice(0, 8),
          client_secret: null,
          redirect_uris: body.redirect_uris || [],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none"
        },
        201
      );
    }
    if (url.pathname === "/oauth/authorize") {
      if (request.method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri") || "";
        const state = url.searchParams.get("state") || "";
        const codeChallenge = url.searchParams.get("code_challenge") || "";
        return new Response(oauthAuthPage(redirectUri, state, codeChallenge), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      if (request.method === "POST") {
        const form = await request.formData();
        const apiKey = form.get("api_key") || "";
        const redirectUri = decodeURIComponent(form.get("redirect_uri") || "");
        const state = decodeURIComponent(form.get("state") || "");
        const codeChallenge = decodeURIComponent(form.get("code_challenge") || "");
        if (!env.MCP_API_KEY || apiKey !== env.MCP_API_KEY) {
          return new Response(
            `<!doctype html><html><body style="font-family:system-ui;padding:40px">
            <p style="color:red">&#10060; Invalid API key. <a href="javascript:history.back()">Try again</a>.</p>
            </body></html>`,
            { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        const code = await computeAuthCode(env.MCP_API_KEY, codeChallenge);
        const dest = new URL(redirectUri);
        dest.searchParams.set("code", code);
        if (state) dest.searchParams.set("state", state);
        return Response.redirect(dest.toString(), 302);
      }
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const bodyText = await request.text();
      const params = new URLSearchParams(bodyText);
      const grantType = params.get("grant_type") || "";
      const code = params.get("code") || "";
      const codeVerifier = params.get("code_verifier") || "";
      if (grantType !== "authorization_code") {
        return json({ error: "unsupported_grant_type" }, 400);
      }
      if (!code || !codeVerifier) {
        return json({ error: "invalid_request", error_description: "code and code_verifier required" }, 400);
      }
      const codeChallenge = await sha256base64url(codeVerifier);
      const expectedCode = await computeAuthCode(env.MCP_API_KEY, codeChallenge);
      if (code !== expectedCode) {
        return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
      }
      return json({
        access_token: env.MCP_API_KEY,
        token_type: "Bearer",
        expires_in: 86400
      });
    }
    if (request.method === "GET" && url.pathname === "/assistant") {
      return new Response(chatPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/api/chat" && request.method === "POST") {
      const pp = request.headers.get("x-passphrase") || "";
      if (!env.ASSISTANT_PASSPHRASE || pp !== env.ASSISTANT_PASSPHRASE) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "bad json" }, 400);
      }
      const messages = body.messages || [];
      const model = body.model === "fugu-ultra" ? "fugu-ultra" : "fugu";
      try {
        const content = await callSakanaSync(env, model, messages);
        return json({ content });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      if (!env.MCP_API_KEY) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32e3, message: "Server missing MCP_API_KEY secret." } }, 500);
      }
      const authHeader = request.headers.get("authorization") || "";
      const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
      const provided = bearer || request.headers.get("x-api-key") || "";
      if (provided !== env.MCP_API_KEY) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized." } }),
          { status: 401, headers: { "content-type": "application/json" } }
        );
      }
      let rpc;
      try {
        rpc = await request.json();
      } catch (e) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
      }
      const method = rpc && rpc.method;
      const id = rpc ? rpc.id : null;
      const ok = /* @__PURE__ */ __name((result) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        headers: { "content-type": "application/json" }
      }), "ok");
      if (method === "initialize") {
        const pv = rpc.params && rpc.params.protocolVersion || "2024-11-05";
        return ok({ protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: "fugu-assistant", version: "1.6.0" } });
      }
      if (typeof method === "string" && method.startsWith("notifications/")) {
        return new Response(null, { status: 202 });
      }
      if (method === "tools/list") {
        return ok({
          tools: [
            {
              name: "ask_fugu",
              description: "Fast reasoning via Sakana Fugu (not Ultra). Best for quick questions, summarization, formatting, and tasks that don't require deep multi-step reasoning. Returns the answer directly in about 5–20 seconds.",
              inputSchema: {
                type: "object",
                properties: {
                  prompt: { type: "string", description: "The question or task." },
                  system: { type: "string", description: "Optional system prompt to set context or persona." }
                },
                required: ["prompt"]
              }
            },
            {
              name: "ask_fugu_ultra",
              description: "Start a deep reasoning job via Sakana Fugu Ultra — a multi-model orchestrator that delivers high-quality analysis. Returns a job_id immediately. Then call get_fugu_answer every 60 seconds until STATUS: completed. Typical jobs take 10–30 minutes; the result is cached server-side for 24 hours, so it is safe to pause polling and resume later. Use for complex legal analysis, contract review, technical deep-dives, and strategy.",
              inputSchema: {
                type: "object",
                properties: {
                  prompt: { type: "string", description: "The question or task requiring deep reasoning." },
                  system: { type: "string", description: "Optional system prompt." }
                },
                required: ["prompt"]
              }
            },
            {
              name: "get_fugu_answer",
              description: "Retrieve the result of a Fugu Ultra job. Returns STATUS: working while the job is in progress (safe to call again with the same job_id after 60 seconds), STATUS: completed with the full answer once done (result is cached for 24h — idempotent), or STATUS: failed with an error if the job permanently failed. Never re-triggers computation.",
              inputSchema: {
                type: "object",
                properties: { job_id: { type: "string", description: "The job_id returned by ask_fugu_ultra." } },
                required: ["job_id"]
              }
            }
          ]
        });
      }
      if (method === "tools/call") {
        const params = rpc.params || {};
        const name = params.name;
        const args = params.arguments || {};
        if (name === "ask_fugu") {
          const prompt = (args.prompt || "").toString();
          const system = (args.system || "").toString();
          if (!prompt) return ok({ content: [{ type: "text", text: "Missing required argument 'prompt'." }], isError: true });
          const messages = [];
          if (system) messages.push({ role: "system", content: system });
          messages.push({ role: "user", content: prompt });
          try {
            const answer = await callSakanaSync(env, "fugu", messages);
            return ok({ content: [{ type: "text", text: answer }], isError: false });
          } catch (e) {
            return ok({ content: [{ type: "text", text: "Fugu error: " + (e && e.message) }], isError: true });
          }
        }
        if (name === "ask_fugu_ultra") {
          const prompt = (args.prompt || "").toString();
          const system = (args.system || "").toString();
          if (!prompt) return ok({ content: [{ type: "text", text: "Missing required argument 'prompt'." }], isError: true });
          if (!env.FUGU_JOBS) return ok({ content: [{ type: "text", text: "Async backend not configured (FUGU_JOBS Durable Object missing)." }], isError: true });
          const jobId = crypto.randomUUID();
          const stub = env.FUGU_JOBS.get(env.FUGU_JOBS.idFromName(jobId));
          const messages = [];
          if (system) messages.push({ role: "system", content: system });
          messages.push({ role: "user", content: prompt });
          await stub.fetch("https://do/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages })
          });
          return ok({
            content: [{ type: "text", text: "Fugu Ultra job started. job_id=" + jobId + "\nCall get_fugu_answer with this job_id every 60 seconds. Fugu Ultra typically takes 10–30 minutes. The result is cached server-side for 24 hours once complete, so it is safe to stop polling and resume later." }],
            isError: false
          });
        }
        if (name === "get_fugu_answer") {
          const jobId = (args.job_id || "").toString();
          if (!jobId) return ok({ content: [{ type: "text", text: "Missing required argument 'job_id'." }], isError: true });
          if (!env.FUGU_JOBS) return ok({ content: [{ type: "text", text: "Async backend not configured." }], isError: true });
          const stub = env.FUGU_JOBS.get(env.FUGU_JOBS.idFromName(jobId));
          const r = await stub.fetch("https://do/status");
          const s = await r.json();
          if (s.status === "done") {
            const elapsedMin = s.elapsed != null ? " (completed in " + Math.floor(s.elapsed / 60) + "m " + s.elapsed % 60 + "s)" : "";
            return ok({
              content: [{ type: "text", text: "STATUS: completed" + elapsedMin + "\n\n" + (s.text || "(no content returned)") }],
              isError: false
            });
          }
          if (s.status === "error") {
            return ok({
              content: [{ type: "text", text: "STATUS: failed\n\n" + (s.error || "Unknown error") }],
              isError: true
            });
          }
          if (s.status === "unknown") {
            return ok({
              content: [{ type: "text", text: "STATUS: not_found — No job found for that job_id. Start a new ask_fugu_ultra job." }],
              isError: true
            });
          }
          const elapsedStr = s.elapsed != null ? Math.floor(s.elapsed / 60) + "m " + s.elapsed % 60 + "s" : "?";
          const lastErrStr = s.lastError ? " — last error: " + s.lastError.slice(0, 150) : "";
          return ok({
            content: [{
              type: "text",
              text: "STATUS: working (elapsed " + elapsedStr + ", attempt " + (s.attempt || 1) + lastErrStr + "). Fugu Ultra is still processing. Wait 60 seconds and call get_fugu_answer again with the same job_id."
            }],
            isError: false
          });
        }
        return ok({ content: [{ type: "text", text: "Unknown tool: " + name }], isError: true });
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } }),
        { headers: { "content-type": "application/json" } }
      );
    }
    return new Response("Not found", { status: 404 });
  }
};
var FuguJob = class {
  static {
    __name(this, "FuguJob");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") {
      const body = await request.json();
      const now = Date.now();
      await this.state.storage.put("job", {
        status: "working",
        messages: body.messages || [],
        created: now,
        startedAt: now
      });
      await this.state.storage.setAlarm(now + 100);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/status") {
      const job = await this.state.storage.get("job") || { status: "unknown" };
      const elapsed = job.created ? Math.round((Date.now() - job.created) / 1e3) : null;
      return new Response(JSON.stringify({
        status: job.status,
        text: job.text,
        error: job.error,
        elapsed,
        attempt: job.attempt,
        completedAt: job.completedAt || null,
        lastError: job.lastError || null,
        lastRetry: job.lastRetry || null
      }), {
        headers: { "content-type": "application/json" }
      });
    }
    return new Response("not found", { status: 404 });
  }
  async alarm() {
    const job = await this.state.storage.get("job");
    if (!job || job.status !== "working") return;
    const attempt = (job.attempt || 0) + 1;
    // TIMEOUT FIX: stream + idle-based abort instead of a flat 90s hard cap.
    const IDLE_TIMEOUT_MS = 9e4;   // abort only after 90s of silence
    const MAX_MS = 12e5;           // 20-min absolute ceiling per attempt
    const RETRY_DELAY_MS = 15e3;
    const MAX_JOB_AGE_MS = 2 * 60 * 60 * 1e3;
    const jobAge = Date.now() - (job.startedAt || job.created || Date.now());
    try {
      const text = await callFuguUltraStream(this.env, job.messages, { idleMs: IDLE_TIMEOUT_MS, maxMs: MAX_MS });
      if (!text || text.trim() === "") {
        throw new Error("empty response from Fugu backend (possible upstream timeout)");
      }
      await this.state.storage.put("job", Object.assign({}, job, {
        status: "done",
        text,
        attempt,
        completedAt: (/* @__PURE__ */ new Date()).toISOString()
      }));
    } catch (e) {
      const msg = e && e.message || "unknown";
      const isTransient = msg.includes("AbortError") || msg.includes("abort") || msg.includes("empty response") || msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("524") || msg.includes("522") || msg.includes("520") || msg.includes("429") || msg.includes("fetch failed") || msg.toLowerCase().includes("network") || msg.toLowerCase().includes("timeout");
      if (isTransient) {
        if (jobAge < MAX_JOB_AGE_MS) {
          await this.state.storage.put("job", Object.assign({}, job, {
            status: "working",
            attempt,
            lastRetry: (/* @__PURE__ */ new Date()).toISOString(),
            lastError: msg
          }));
          await this.state.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
        } else {
          const ageMin = Math.round(jobAge / 6e4);
          await this.state.storage.put("job", Object.assign({}, job, {
            status: "error",
            error: "Fugu Ultra did not respond after " + ageMin + " minutes (" + attempt + " attempts). The model may be unavailable — please try again later.",
            attempt
          }));
        }
      } else {
        await this.state.storage.put("job", Object.assign({}, job, {
          status: "error",
          error: msg + (attempt > 1 ? " (after " + attempt + " attempts)" : ""),
          attempt
        }));
      }
    }
  }
};
export {
  FuguJob,
  worker_default as default
};
