var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js  — mike-assistant MCP connector
// TIMEOUT FIX (v1.3.0): replaced the hard 110s per-attempt abort with an
// idle-based abort + generous absolute cap, so a long-but-progressing
// generation (dense multi-section reviews) is no longer killed mid-stream.
//   - MIKE_IDLE_TIMEOUT_MS: abort only if NO bytes arrive for this long.
//   - MIKE_MAX_MS: absolute ceiling per attempt.
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, accept",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
  "Access-Control-Max-Age": "86400"
};
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS }
  });
}
__name(json, "json");
async function mintJwt(env) {
  const r = await fetch(env.MIKE_SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { "content-type": "application/json", apikey: env.MIKE_SUPABASE_ANON_KEY },
    body: JSON.stringify({ email: env.MIKE_EMAIL, password: env.MIKE_PASSWORD })
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("Supabase auth " + r.status + ": " + t.slice(0, 200));
  }
  const d = await r.json();
  if (!d.access_token) throw new Error("No access_token returned by Supabase");
  return d.access_token;
}
__name(mintJwt, "mintJwt");
// Idle-aware call: resets the abort timer on every streamed chunk. A response
// that keeps producing tokens will run up to MIKE_MAX_MS; a stalled connection
// aborts after MIKE_IDLE_TIMEOUT_MS of silence.
async function callMike(env, prompt, opts) {
  const idleMs = (opts && opts.idleMs) || 9e4;    // 90s of silence => abort
  const maxMs = (opts && opts.maxMs) || 15e5;     // 25 min absolute ceiling
  const controller = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), idleMs);
  };
  const hardTimer = setTimeout(() => controller.abort(), maxMs);
  armIdle();
  try {
    const r = await fetch(env.MIKE_BACKEND_URL + "/chat", {
      method: "POST",
      headers: { "x-connector-key": env.CONNECTOR_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error("Mike /chat " + r.status + ": " + t.slice(0, 300));
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
          if (o && o.text) text += o.text;
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
__name(callMike, "callMike");
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
function validMcpKeys(env) {
  const out = [];
  const add = /* @__PURE__ */ __name((v) => {
    const t = (v || "").trim();
    if (t && !out.includes(t)) out.push(t);
  }, "add");
  add(env.MCP_API_KEY);
  for (const k of (env.MCP_API_KEYS || "").split(",")) add(k);
  return out;
}
__name(validMcpKeys, "validMcpKeys");
function oauthAuthPage(redirectUri, state, codeChallenge) {
  const esc = /* @__PURE__ */ __name((s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;"), "esc");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mike Legal AI — Authorize</title>
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
  input[type=password]:focus{border-color:#01696F;box-shadow:0 0 0 3px rgba(1,105,111,.12)}
  button{display:block;width:100%;margin-top:16px;background:#01696F;color:#fff;border:0;
         border-radius:8px;padding:11px;font-size:1rem;font-weight:600;cursor:pointer}
  button:hover{background:#015a60}
</style>
</head>
<body>
<div class="card">
  <div class="logo">⚖️</div>
  <h1>Connect to Mike Legal AI</h1>
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
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response("Mike Legal AI — MCP connector v1.6.2.", {
        headers: { "content-type": "text/plain", ...CORS }
      });
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
          client_id: "mike-client-" + crypto.randomUUID().slice(0, 8),
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
        const apiKey = (form.get("api_key") || "").trim();
        const redirectUri = decodeURIComponent(form.get("redirect_uri") || "");
        const state = decodeURIComponent(form.get("state") || "");
        const codeChallenge = decodeURIComponent(form.get("code_challenge") || "");
        const keys = validMcpKeys(env);
        if (!keys.length || !keys.includes(apiKey)) {
          return new Response(
            `<!doctype html><html><body style="font-family:system-ui;padding:40px">
            <p style="color:red">&#10060; Invalid API key. <a href="javascript:history.back()">Try again</a>.</p>
            </body></html>`,
            { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        const code = await computeAuthCode(apiKey, codeChallenge);
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
      let matchedKey = null;
      for (const k of validMcpKeys(env)) {
        if (code === await computeAuthCode(k, codeChallenge)) {
          matchedKey = k;
          break;
        }
      }
      if (!matchedKey) {
        return json({ error: "invalid_grant", error_description: "Invalid authorization code" }, 400);
      }
      return json({
        access_token: matchedKey,
        token_type: "Bearer",
        expires_in: 86400
      });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const mcpKeys = validMcpKeys(env);
      if (!mcpKeys.length) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32e3, message: "Server missing MCP_API_KEY secret." } }, 500);
      }
      const authHeader = request.headers.get("authorization") || "";
      const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
      const provided = (bearer || request.headers.get("x-api-key") || "").trim();
      if (!mcpKeys.includes(provided)) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized." } }),
          { status: 401, headers: { "content-type": "application/json", ...CORS } }
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
        headers: { "content-type": "application/json", ...CORS }
      }), "ok");
      if (method === "initialize") {
        const pv = rpc.params && rpc.params.protocolVersion || "2024-11-05";
        return ok({ protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: "mike-legal", version: "1.5.0" } });
      }
      if (typeof method === "string" && method.startsWith("notifications/")) {
        return new Response(null, { status: 202, headers: CORS });
      }
      if (method === "tools/list") {
        return ok({
          tools: [
            {
              name: "ask_mike",
              description: "Start a Mike Legal AI review — bioaccess\xAE contract and Latin-American regulatory legal analysis (NDAs, MSAs, work orders, distribution/IDE/CRO agreements). Paste the full legal question and any contract/clause text as 'prompt'. Returns a job_id immediately; then poll get_mike_answer until the analysis is ready. Complex reviews can take 5–30+ minutes; the job retries automatically so keep polling.",
              inputSchema: {
                type: "object",
                properties: { prompt: { type: "string", description: "The legal question plus any contract or clause text to review." } },
                required: ["prompt"]
              }
            },
            {
              name: "get_mike_answer",
              description: "Retrieve the result of a Mike Legal job started with ask_mike. Returns STATUS: completed (with the analysis), STATUS: working (still processing — wait 60 seconds and call again with the same job_id), or STATUS: failed. Long answers are returned in numbered parts; the header says 'part X of N' and, when more remains, tells you to call again with the next part number. Always fetch every part. For long reviews the job retries automatically; keep polling for up to 2 hours.",
              inputSchema: {
                type: "object",
                properties: {
                  job_id: { type: "string", description: "The job_id returned by ask_mike." },
                  part: { type: "integer", description: "Optional. For long answers split into multiple parts, the 1-based part number to retrieve (default 1). The completed response reports the total number of parts." }
                },
                required: ["job_id"]
              }
            },
            {
              name: "mike_ingest_document",
              description: "Add a document to Mike's knowledge base so it becomes searchable by ask_mike with citations — beyond contracts: feasibility analyses, budgets, regulatory texts, competitive/substantiation files, etc. Provide the document as one of: 'text' (raw text/markdown), 'url' (a public link Mike will fetch), or 'file_base64' (+ 'filename') for an uploaded file. IMPORTANT: for a Google Drive file, the caller should first read the file's contents (via its Drive access) and pass them here as 'text' or 'file_base64' — you may also pass 'drive_file_id' and 'source_url' as metadata for dedupe and citation. Optional: 'source_tag' (e.g. feasibility, regulatory, substantiation, contract; default 'manual'), 'title', 'doc_type'. Parses PDF/DOCX/MD/TXT and OCRs scanned PDFs. Dedupes by content hash. Returns the ingest status and chunk count.",
              inputSchema: {
                type: "object",
                properties: {
                  text: { type: "string", description: "Raw document text or markdown." },
                  url: { type: "string", description: "Public URL for Mike to fetch and ingest." },
                  file_base64: { type: "string", description: "Base64-encoded file bytes (PDF/DOCX/etc.)." },
                  filename: { type: "string", description: "Original filename (helps detect type + set title), e.g. 'Kanjin_Phase1_Feasibility_Budget.pdf'." },
                  mime_type: { type: "string", description: "Optional MIME type of the file." },
                  drive_file_id: { type: "string", description: "Optional Google Drive file id, stored as metadata for dedupe/versioning." },
                  source_url: { type: "string", description: "Optional link back to the source (e.g. the Drive view URL) for citations." },
                  source_tag: { type: "string", description: "Category tag: feasibility | regulatory | substantiation | competitive | contract | manual (default 'manual')." },
                  title: { type: "string", description: "Optional human title; defaults to the filename." },
                  doc_type: { type: "string", description: "Optional: contract | template | regulatory | reference (default 'reference')." },
                  force: { type: "boolean", description: "Re-ingest even if an identical document already exists." }
                },
                required: []
              }
            }
          ]
        });
      }
      if (method === "tools/call") {
        const params = rpc.params || {};
        const name = params.name;
        const args = params.arguments || {};
        if (name === "ask_mike") {
          const prompt = (args.prompt || "").toString();
          if (!prompt) return ok({ content: [{ type: "text", text: "Missing required argument 'prompt'." }], isError: true });
          if (!env.MIKE_JOBS) return ok({ content: [{ type: "text", text: "Async backend not configured (MIKE_JOBS Durable Object missing)." }], isError: true });
          const jobId = crypto.randomUUID();
          const stub = env.MIKE_JOBS.get(env.MIKE_JOBS.idFromName(jobId));
          await stub.fetch("https://do/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
          return ok({
            content: [{ type: "text", text: "Mike Legal job started. job_id=" + jobId + "\nNow call get_mike_answer with this exact job_id, polling about every 20 seconds until the analysis is ready (usually 1–3 minutes)." }],
            isError: false
          });
        }
        if (name === "get_mike_answer") {
          const jobId = (args.job_id || "").toString();
          if (!jobId) return ok({ content: [{ type: "text", text: "Missing required argument 'job_id'." }], isError: true });
          if (!env.MIKE_JOBS) return ok({ content: [{ type: "text", text: "Async backend not configured." }], isError: true });
          const stub = env.MIKE_JOBS.get(env.MIKE_JOBS.idFromName(jobId));
          const r = await stub.fetch("https://do/status");
          const s = await r.json();
          if (s.status === "done") {
            const elapsedMin = s.elapsed != null ? " (completed in " + Math.floor(s.elapsed / 60) + "m " + s.elapsed % 60 + "s)" : "";
            const full = s.text || "(no content returned)";
            // Some MCP clients (e.g. Perplexity ~19k, ChatGPT) cap tool-result size and
            // silently truncate long answers. Return the answer in numbered parts that
            // stay under that ceiling; the client fetches subsequent parts via `part`.
            const CHUNK = 15000;
            const total = Math.max(1, Math.ceil(full.length / CHUNK));
            let part = parseInt(args.part, 10);
            if (!Number.isFinite(part) || part < 1) part = 1;
            if (part > total) part = total;
            const slice = full.slice((part - 1) * CHUNK, part * CHUNK);
            const header = "STATUS: completed" + elapsedMin + (total > 1 ? " — part " + part + " of " + total : "");
            const footer = total > 1 && part < total
              ? "\n\n[Response continues — call get_mike_answer again with job_id=\"" + jobId + "\" and part=" + (part + 1) + " to get the next part (" + (part + 1) + " of " + total + ").]"
              : "";
            return ok({
              content: [{ type: "text", text: header + "\n\n" + slice + footer }],
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
              content: [{ type: "text", text: "STATUS: not_found — No job found for that job_id. Start a new ask_mike job." }],
              isError: true
            });
          }
          const elapsedStr = s.elapsed != null ? Math.floor(s.elapsed / 60) + "m " + s.elapsed % 60 + "s" : "?";
          return ok({
            content: [{
              type: "text",
              text: "STATUS: working (elapsed " + elapsedStr + ", attempt " + (s.attempt || 1) + (s.lastError ? " — last error: " + s.lastError.slice(0, 150) : "") + "). Mike Legal is still processing. Wait 60 seconds and call get_mike_answer again with the same job_id."
            }],
            isError: false
          });
        }
        if (name === "mike_ingest_document") {
          const body = {};
          for (const k of ["text", "url", "drive_file_id", "file_base64", "filename", "mime_type", "source_tag", "title", "source_url", "doc_type"]) {
            if (args[k] != null && args[k] !== "") body[k] = args[k];
          }
          if (args.force === true) body.force = true;
          if (!body.text && !body.url && !body.file_base64) {
            return ok({ content: [{ type: "text", text: "Provide one of: text, url, or file_base64. For a Google Drive file, read its contents first (via your Drive access) and pass them as text or file_base64." }], isError: true });
          }
          if (!env.MIKE_BACKEND_URL || !env.CONNECTOR_API_KEY) {
            return ok({ content: [{ type: "text", text: "Ingestion backend not configured (MIKE_BACKEND_URL / CONNECTOR_API_KEY)." }], isError: true });
          }
          try {
            const r = await fetch(env.MIKE_BACKEND_URL.replace(/\/$/, "") + "/kb/ingest", {
              method: "POST",
              headers: { "content-type": "application/json", "x-connector-key": env.CONNECTOR_API_KEY },
              body: JSON.stringify(body)
            });
            const t = await r.text();
            let out;
            try { out = JSON.parse(t); } catch (e) { out = null; }
            if (!r.ok || !out || out.error) {
              return ok({ content: [{ type: "text", text: "Ingest failed (" + r.status + "): " + ((out && out.error) || t.slice(0, 300)) }], isError: true });
            }
            const msg = "Ingested “" + (out.title || "document") + "” into Mike's knowledge base.\nstatus=" + out.status + ", chunks=" + out.chunks + ", source_tag=" + out.source_tag + (out.ocr_used ? ", OCR=yes" : "") + ".\nIt is now retrievable by ask_mike, with citations back to this document.";
            return ok({ content: [{ type: "text", text: msg }], isError: false });
          } catch (e) {
            return ok({ content: [{ type: "text", text: "Ingest request error: " + (e && e.message || String(e)) }], isError: true });
          }
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
var MikeJob = class {
  static {
    __name(this, "MikeJob");
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
        prompt: (body.prompt || "").toString(),
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
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }
  async alarm() {
    const job = await this.state.storage.get("job");
    if (!job || job.status !== "working") return;
    const attempt = (job.attempt || 0) + 1;
    // TIMEOUT FIX: idle-based abort (no bytes for 90s) + 10-min absolute ceiling,
    // instead of a flat 110s cap that killed long-but-progressing generations.
    const MIKE_IDLE_TIMEOUT_MS = 9e4;
    const MIKE_MAX_MS = 15e5;
    const RETRY_DELAY_MS = 15e3;
    const MAX_JOB_AGE_MS = 2 * 60 * 60 * 1e3;
    const jobAge = Date.now() - (job.startedAt || job.created || Date.now());
    try {
      const text = await callMike(this.env, job.prompt, { idleMs: MIKE_IDLE_TIMEOUT_MS, maxMs: MIKE_MAX_MS });
      if (!text || text.trim() === "") {
        throw new Error("empty response from Mike backend (possible upstream timeout)");
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
            error: "Mike Legal did not complete after " + ageMin + " minutes (" + attempt + " attempts). The service may be unavailable — please try again later.",
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
  MikeJob,
  worker_default as default
};
