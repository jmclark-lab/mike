var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js  — mike-assistant MCP connector
// Long-running generations are owned by Railway async jobs. This Worker only
// starts or polls them with bounded requests, so Cloudflare request lifetime
// limits cannot duplicate a council or discard its completed result.
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-api-key, content-type, mcp-protocol-version, mcp-session-id, accept",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
  "Access-Control-Max-Age": "86400"
};
var DEFAULT_MAX_JOB_AGE_MS = 2 * 60 * 60 * 1e3;
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS }
  });
}
__name(json, "json");
// Start-or-poll a Railway-owned async job. Each Worker request is short-lived;
// the long council execution stays in Railway and is never duplicated merely
// because Cloudflare ends a request after its platform lifetime limit.
async function callMike(env, prompt, opts) {
  const jobId = opts && opts.jobId;
  if (!jobId) throw new Error("missing Railway connector job id");
  const controller = new AbortController();
  const requestMs = (opts && opts.requestMs) || 6e4;
  const timer = setTimeout(() => controller.abort(), requestMs);
  try {
    const base = env.MIKE_BACKEND_URL.replace(/\/$/, "");
    const r = await fetch(base + "/connector/jobs/" + encodeURIComponent(jobId), {
      method: "POST",
      headers: { "x-connector-key": env.CONNECTOR_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: controller.signal
    });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 202) {
      throw new Error("Mike connector job " + r.status + ": " + ((payload && payload.detail) || "unknown error"));
    }
    return payload;
  } finally {
    clearTimeout(timer);
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
async function opaqueToken(prefix) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return prefix + "_" + await toBase64url(bytes.buffer);
}
__name(opaqueToken, "opaqueToken");
function authStub(env) {
  if (!env.MIKE_AUTH) return null;
  return env.MIKE_AUTH.get(env.MIKE_AUTH.idFromName("global"));
}
__name(authStub, "authStub");
async function callAuth(env, path, body) {
  const stub = authStub(env);
  if (!stub) throw new Error("MIKE_AUTH Durable Object is not configured.");
  const response = await stub.fetch("https://auth" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}
__name(callAuth, "callAuth");
async function authenticateMcp(request, env) {
  const authHeader = request.headers.get("authorization") || "";
  const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const provided = (bearer || request.headers.get("x-api-key") || "").trim();
  if (!provided) return null;
  for (const key of validMcpKeys(env)) {
    if (provided === key) {
      return { principal: "key:" + await sha256base64url(key), kind: "api_key" };
    }
  }
  if (!env.MIKE_AUTH) return null;
  const validation = await callAuth(env, "/validate", { access_token: provided });
  if (!validation.ok || !validation.payload.principal) return null;
  return { principal: validation.payload.principal, kind: "oauth" };
}
__name(authenticateMcp, "authenticateMcp");
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
function oauthAuthPage(redirectUri, state, codeChallenge, clientId) {
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
    <input type="hidden" name="client_id" value="${esc(encodeURIComponent(clientId))}">
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
      return new Response("Mike Legal AI — MCP connector v1.7.0.", {
        headers: { "content-type": "text/plain", ...CORS }
      });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return json({
        resource: url.origin + "/mcp",
        authorization_servers: [url.origin],
        bearer_methods_supported: ["header"]
      });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({
        issuer: url.origin,
        authorization_endpoint: url.origin + "/oauth/authorize",
        token_endpoint: url.origin + "/oauth/token",
        registration_endpoint: url.origin + "/oauth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
    if (url.pathname === "/oauth/register" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const registered = await callAuth(env, "/register", { redirect_uris: body.redirect_uris || [] }).catch((e) => ({ ok: false, payload: { error: e.message } }));
      if (!registered.ok) return json({ error: "invalid_client_metadata", error_description: registered.payload.error || "Registration failed." }, 400);
      return json({
        client_id: registered.payload.client_id,
        client_secret: null,
        redirect_uris: registered.payload.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      }, 201);
    }
    if (url.pathname === "/oauth/authorize") {
      if (request.method === "GET") {
        const redirectUri = url.searchParams.get("redirect_uri") || "";
        const state = url.searchParams.get("state") || "";
        const codeChallenge = url.searchParams.get("code_challenge") || "";
        const clientId = url.searchParams.get("client_id") || "";
        const clientCheck = await callAuth(env, "/validate-client", { client_id: clientId, redirect_uri: redirectUri }).catch(() => ({ ok: false }));
        if (!clientCheck.ok || !codeChallenge) {
          return json({ error: "invalid_request", error_description: "Invalid client, redirect URI, or PKCE challenge." }, 400);
        }
        return new Response(oauthAuthPage(redirectUri, state, codeChallenge, clientId), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      if (request.method === "POST") {
        const form = await request.formData();
        const apiKey = (form.get("api_key") || "").trim();
        const redirectUri = decodeURIComponent(form.get("redirect_uri") || "");
        const state = decodeURIComponent(form.get("state") || "");
        const codeChallenge = decodeURIComponent(form.get("code_challenge") || "");
        const clientId = decodeURIComponent(form.get("client_id") || "");
        const keys = validMcpKeys(env);
        if (!keys.length || !keys.includes(apiKey)) {
          return new Response(
            `<!doctype html><html><body style="font-family:system-ui;padding:40px">
            <p style="color:red">&#10060; Invalid API key. <a href="javascript:history.back()">Try again</a>.</p>
            </body></html>`,
            { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        const principal = "key:" + await sha256base64url(apiKey);
        const issued = await callAuth(env, "/authorize", {
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: codeChallenge,
          principal
        }).catch((e) => ({ ok: false, payload: { error: e.message } }));
        if (!issued.ok) return json({ error: "server_error", error_description: issued.payload.error || "Authorization failed." }, 500);
        const code = issued.payload.code;
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
      if (grantType !== "authorization_code" && grantType !== "refresh_token") {
        return json({ error: "unsupported_grant_type" }, 400);
      }
      const exchanged = await callAuth(env, "/token", {
        grant_type: grantType,
        code: params.get("code") || "",
        code_verifier: params.get("code_verifier") || "",
        client_id: params.get("client_id") || "",
        redirect_uri: params.get("redirect_uri") || "",
        refresh_token: params.get("refresh_token") || ""
      }).catch((e) => ({ ok: false, payload: { error: e.message } }));
      if (!exchanged.ok) return json({ error: exchanged.payload.error || "invalid_grant", error_description: exchanged.payload.error_description || "Token exchange failed." }, exchanged.status || 400);
      return json(exchanged.payload);
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const mcpKeys = validMcpKeys(env);
      if (!mcpKeys.length) {
        return json({ jsonrpc: "2.0", id: null, error: { code: -32e3, message: "Server missing MCP_API_KEY secret." } }, 500);
      }
      const auth = await authenticateMcp(request, env);
      if (!auth) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized." } }),
          { status: 401, headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`, ...CORS } }
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
        return ok({
          protocolVersion: pv,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "mike-legal", version: "1.7.0" },
          instructions: "Start legal reviews with ask_mike, then poll get_mike_answer using retry_after_seconds. Fetch every numbered part before synthesizing. Treat Mike's analysis as legal work product requiring human counsel review."
        });
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
                properties: {
                  prompt: { type: "string", minLength: 1, maxLength: 500000, description: "The legal question plus any contract or clause text to review." },
                  idempotency_key: { type: "string", minLength: 1, maxLength: 128, description: "Optional stable key. Reusing it for the same authenticated principal returns the existing job instead of starting a duplicate." }
                },
                required: ["prompt"]
              },
              outputSchema: {
                type: "object",
                properties: {
                  job_id: { type: "string" },
                  status: { type: "string", enum: ["working"] },
                  retry_after_seconds: { type: "integer" }
                },
                required: ["job_id", "status", "retry_after_seconds"]
              },
              annotations: { title: "Start Mike legal review", readOnlyHint: false, destructiveHint: false, openWorldHint: false }
            },
            {
              name: "get_mike_answer",
              description: "Retrieve the result of a Mike Legal job started with ask_mike. Returns STATUS: completed (with the analysis), STATUS: working (still processing — wait 60 seconds and call again with the same job_id), or STATUS: failed. Long answers are returned in numbered parts; the header says 'part X of N' and, when more remains, tells you to call again with the next part number. Always fetch every part. For long reviews the job retries automatically; keep polling for up to 2 hours.",
              inputSchema: {
                type: "object",
                properties: {
                  job_id: { type: "string", description: "The job_id returned by ask_mike." },
                  part: { type: "integer", minimum: 1, description: "Optional. For long answers split into multiple parts, the 1-based part number to retrieve (default 1). The completed response reports the total number of parts." }
                },
                required: ["job_id"]
              },
              outputSchema: {
                type: "object",
                properties: {
                  status: { type: "string", enum: ["working", "completed", "failed", "not_found"] },
                  job_id: { type: "string" },
                  part: { type: "integer" },
                  total_parts: { type: "integer" },
                  elapsed_seconds: { type: ["integer", "null"] },
                  retry_after_seconds: { type: "integer" },
                  error: { type: "string" },
                  answer: { type: "string", description: "The analysis text for the requested part (present when status is completed). Concatenate answer across parts 1..total_parts for the full response." },
                  next_part: { type: ["integer", "null"], description: "The next part number to fetch, or null when this is the last/only part." }
                },
                required: ["status", "job_id"]
              },
              annotations: { title: "Get Mike legal review", readOnlyHint: true, destructiveHint: false, openWorldHint: false }
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
              },
              outputSchema: {
                type: "object",
                properties: {
                  document_id: { type: "string" },
                  title: { type: "string" },
                  status: { type: "string" },
                  chunks: { type: "integer" },
                  source_tag: { type: "string" },
                  ocr_used: { type: "boolean" }
                },
                required: ["document_id", "title", "status", "chunks"]
              },
              annotations: { title: "Ingest legal knowledge document", readOnlyHint: false, destructiveHint: false, openWorldHint: true }
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
          if (prompt.length > 500000) return ok({ content: [{ type: "text", text: "Prompt exceeds the 500,000 character limit. Ingest documents first and submit a focused legal question." }], isError: true });
          if (!env.MIKE_JOBS) return ok({ content: [{ type: "text", text: "Async backend not configured (MIKE_JOBS Durable Object missing)." }], isError: true });
          const idempotencyKey = (args.idempotency_key || "").toString().trim();
          if (idempotencyKey.length > 128) return ok({ content: [{ type: "text", text: "idempotency_key exceeds 128 characters." }], isError: true });
          const jobId = idempotencyKey ? "idem_" + await sha256base64url(auth.principal + ":" + idempotencyKey) : crypto.randomUUID();
          const stub = env.MIKE_JOBS.get(env.MIKE_JOBS.idFromName(jobId));
          const started = await stub.fetch("https://do/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, principal: auth.principal, idempotencyKey: idempotencyKey || null, jobId }) });
          if (!started.ok) return ok({ content: [{ type: "text", text: "Unable to start Mike Legal job (" + started.status + ")." }], isError: true });
          const structuredContent = { job_id: jobId, status: "working", retry_after_seconds: 20 };
          return ok({
            content: [{ type: "text", text: "Mike Legal job started. job_id=" + jobId + "\nNow call get_mike_answer with this exact job_id, polling about every 20 seconds until the analysis is ready (usually 1–3 minutes)." }],
            structuredContent,
            isError: false
          });
        }
        if (name === "get_mike_answer") {
          const jobId = (args.job_id || "").toString();
          if (!jobId) return ok({ content: [{ type: "text", text: "Missing required argument 'job_id'." }], isError: true });
          if (!env.MIKE_JOBS) return ok({ content: [{ type: "text", text: "Async backend not configured." }], isError: true });
          const stub = env.MIKE_JOBS.get(env.MIKE_JOBS.idFromName(jobId));
          let requestedPart = parseInt(args.part, 10);
          if (!Number.isFinite(requestedPart) || requestedPart < 1) requestedPart = 1;
          const r = await stub.fetch("https://do/status?part=" + requestedPart, { headers: { "x-mike-principal": auth.principal } });
          if (r.status === 403) return ok({ content: [{ type: "text", text: "STATUS: not_found — No job found for that job_id." }], structuredContent: { status: "not_found", job_id: jobId }, isError: true });
          const s = await r.json();
          if (s.status === "done") {
            const elapsedMin = s.elapsed != null ? " (completed in " + Math.floor(s.elapsed / 60) + "m " + s.elapsed % 60 + "s)" : "";
            const full = s.text || "(no content returned)";
            const total = s.totalParts || 1;
            const part = s.part || 1;
            const slice = full;
            const header = "STATUS: completed" + elapsedMin + (total > 1 ? " — part " + part + " of " + total : "");
            const footer = total > 1 && part < total
              ? "\n\n[Response continues — call get_mike_answer again with job_id=\"" + jobId + "\" and part=" + (part + 1) + " to get the next part (" + (part + 1) + " of " + total + ").]"
              : "";
            return ok({
              content: [{ type: "text", text: header + "\n\n" + slice + footer }],
              structuredContent: { status: "completed", job_id: jobId, part, total_parts: total, elapsed_seconds: s.elapsed, answer: slice, next_part: total > 1 && part < total ? part + 1 : null },
              isError: false
            });
          }
          if (s.status === "error") {
            return ok({
              content: [{ type: "text", text: "STATUS: failed\n\n" + (s.error || "Unknown error") }],
              structuredContent: { status: "failed", job_id: jobId, error: s.error || "Unknown error", elapsed_seconds: s.elapsed },
              isError: true
            });
          }
          if (s.status === "unknown") {
            return ok({
              content: [{ type: "text", text: "STATUS: not_found — No job found for that job_id. Start a new ask_mike job." }],
              structuredContent: { status: "not_found", job_id: jobId },
              isError: true
            });
          }
          const elapsedStr = s.elapsed != null ? Math.floor(s.elapsed / 60) + "m " + s.elapsed % 60 + "s" : "?";
          return ok({
            content: [{
              type: "text",
              text: "STATUS: working (elapsed " + elapsedStr + ", attempt " + (s.attempt || 1) + (s.lastError ? " — last error: " + s.lastError.slice(0, 150) : "") + "). Mike Legal is still processing. Wait 60 seconds and call get_mike_answer again with the same job_id."
            }],
            structuredContent: { status: "working", job_id: jobId, elapsed_seconds: s.elapsed, retry_after_seconds: 60 },
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
            return ok({ content: [{ type: "text", text: msg }], structuredContent: { document_id: out.document_id, title: out.title || "document", status: out.status, chunks: out.chunks, source_tag: out.source_tag, ocr_used: !!out.ocr_used }, isError: false });
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
      const existing = await this.state.storage.get("job");
      if (existing && body.idempotencyKey && existing.idempotencyKey === body.idempotencyKey && existing.principal === body.principal) {
        return new Response(JSON.stringify({ ok: true, reused: true, status: existing.status }), { headers: { "content-type": "application/json" } });
      }
      await this.state.storage.put("job", {
        status: "working",
        prompt: (body.prompt || "").toString(),
        principal: (body.principal || "").toString(),
        idempotencyKey: body.idempotencyKey || null,
        backendJobId: (body.jobId || "").toString() || null,
        created: now,
        startedAt: now
      });
      await this.state.storage.setAlarm(now + 100);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/status") {
      let job = await this.state.storage.get("job") || { status: "unknown" };
      const principal = request.headers.get("x-mike-principal") || "";
      if (job.status !== "unknown" && (!principal || principal !== job.principal)) {
        return new Response(JSON.stringify({ status: "unknown" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const maxJobAgeMs = Number(this.env.MAX_JOB_AGE_MS) || DEFAULT_MAX_JOB_AGE_MS;
      const jobAge = Date.now() - (job.startedAt || job.created || Date.now());
      if (job.status === "working" && jobAge >= maxJobAgeMs) {
        job = Object.assign({}, job, {
          status: "error",
          error: "Mike Legal exceeded its maximum job age and was stopped. Please start a new request.",
          prompt: null,
          completedAt: (/* @__PURE__ */ new Date()).toISOString(),
          expiresAt: Date.now() + 24 * 60 * 60 * 1e3
        });
        await this.state.storage.put("job", job);
        await this.state.storage.setAlarm(job.expiresAt);
      }
      const elapsed = job.created ? Math.round((Date.now() - job.created) / 1e3) : null;
      let part = Number.parseInt(url.searchParams.get("part") || "1", 10);
      if (!Number.isFinite(part) || part < 1) part = 1;
      let totalParts = job.totalParts || 1;
      if (part > totalParts) part = totalParts;
      let resultText;
      if (job.status === "done") {
        if (job.totalParts) {
          resultText = await this.state.storage.get("result:" + part) || "";
        } else {
          const legacyText = job.text || "";
          totalParts = Math.max(1, Math.ceil(legacyText.length / 15000));
          if (part > totalParts) part = totalParts;
          resultText = legacyText.slice((part - 1) * 15000, part * 15000);
        }
      }
      return new Response(JSON.stringify({
        status: job.status,
        text: resultText,
        part,
        totalParts,
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
    if (!job) return;
    if (job.status !== "working") {
      if (job.expiresAt && Date.now() >= job.expiresAt) await this.state.storage.deleteAll();
      return;
    }
    const attempt = job.attempt || 1;
    const RETRY_DELAY_MS = Number(this.env.RETRY_DELAY_MS) || 2e4;
    const MAX_JOB_AGE_MS = Number(this.env.MAX_JOB_AGE_MS) || DEFAULT_MAX_JOB_AGE_MS;
    const jobAge = Date.now() - (job.startedAt || job.created || Date.now());
    const backendJobId = job.backendJobId || crypto.randomUUID();
    const activeJob = Object.assign({}, job, {
      attempt,
      backendJobId,
      attemptStartedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
    await this.state.storage.put("job", activeJob);
    try {
      const result = await callMike(this.env, job.prompt, { jobId: backendJobId });
      if (result && result.status === "working") {
        await this.state.storage.put("job", Object.assign({}, activeJob, {
          status: "working",
          lastProgress: (/* @__PURE__ */ new Date()).toISOString()
        }));
        await this.state.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
        return;
      }
      if (result && result.status === "error") {
        throw new Error(result.error || "Mike backend job failed");
      }
      const text = result && result.status === "done" ? result.text : "";
      if (!text || text.trim() === "") {
        throw new Error("empty response from Mike backend (possible upstream timeout)");
      }
      const chunks = [];
      for (let i = 0; i < text.length; i += 15000) chunks.push(text.slice(i, i + 15000));
      if (!chunks.length) chunks.push("");
      for (let i = 0; i < chunks.length; i++) await this.state.storage.put("result:" + (i + 1), chunks[i]);
      const currentJob = await this.state.storage.get("job");
      if (!currentJob || currentJob.status !== "working") return;
      const expiresAt = Date.now() + 72 * 60 * 60 * 1e3;
      await this.state.storage.put("job", Object.assign({}, activeJob, {
        status: "done",
        prompt: null,
        totalParts: chunks.length,
        resultChars: text.length,
        attempt,
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        expiresAt
      }));
      await this.state.storage.setAlarm(expiresAt);
    } catch (e) {
      const msg = e && e.message || "unknown";
      const isTransient = msg.includes("AbortError") || msg.includes("abort") || msg.includes("empty response") || msg.includes("502") || msg.includes("503") || msg.includes("504") || msg.includes("524") || msg.includes("522") || msg.includes("520") || msg.includes("429") || msg.includes("fetch failed") || msg.toLowerCase().includes("network") || msg.toLowerCase().includes("timeout");
      if (isTransient) {
        if (jobAge < MAX_JOB_AGE_MS) {
          await this.state.storage.put("job", Object.assign({}, activeJob, {
            status: "working",
            attempt,
            lastRetry: (/* @__PURE__ */ new Date()).toISOString(),
            lastError: msg
          }));
          await this.state.storage.setAlarm(Date.now() + RETRY_DELAY_MS);
        } else {
          const ageMin = Math.round(jobAge / 6e4);
          await this.state.storage.put("job", Object.assign({}, activeJob, {
            status: "error",
            error: "Mike Legal did not complete after " + ageMin + " minutes (" + attempt + " attempts). The service may be unavailable — please try again later.",
            attempt,
            prompt: null,
            expiresAt: Date.now() + 24 * 60 * 60 * 1e3
          }));
          await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1e3);
        }
      } else {
        await this.state.storage.put("job", Object.assign({}, activeJob, {
          status: "error",
          error: msg + (attempt > 1 ? " (after " + attempt + " attempts)" : ""),
          attempt,
          prompt: null,
          expiresAt: Date.now() + 24 * 60 * 60 * 1e3
        }));
        await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1e3);
      }
    }
  }
};
var MikeAuth = class {
  static {
    __name(this, "MikeAuth");
  }
  constructor(state) {
    this.state = state;
  }
  async putExpiring(key, value, expiresAt) {
    await this.state.storage.put(key, Object.assign({}, value, { expiresAt }));
    const current = await this.state.storage.get("nextExpiry");
    if (!current || expiresAt < current) {
      await this.state.storage.put("nextExpiry", expiresAt);
      await this.state.storage.setAlarm(expiresAt);
    }
  }
  validRedirect(uri) {
    try {
      const parsed = new URL(uri);
      return parsed.protocol === "https:" || parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
    } catch (e) {
      return false;
    }
  }
  async issueTokens(principal, clientId) {
    const accessToken = await opaqueToken("mike_at");
    const refreshToken = await opaqueToken("mike_rt");
    const now = Date.now();
    await this.putExpiring("access:" + await sha256base64url(accessToken), { principal, clientId }, now + 24 * 60 * 60 * 1e3);
    await this.putExpiring("refresh:" + await sha256base64url(refreshToken), { principal, clientId }, now + 30 * 24 * 60 * 60 * 1e3);
    return { access_token: accessToken, refresh_token: refreshToken, token_type: "Bearer", expires_in: 86400 };
  }
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (url.pathname === "/register") {
      const redirects = Array.isArray(body.redirect_uris) ? [...new Set(body.redirect_uris.filter((x) => typeof x === "string" && this.validRedirect(x)))] : [];
      if (!redirects.length) return json({ error: "At least one valid HTTPS redirect URI is required." }, 400);
      const clientId = "mike-client-" + crypto.randomUUID();
      await this.state.storage.put("client:" + clientId, { redirectUris: redirects, createdAt: Date.now() });
      return json({ client_id: clientId, redirect_uris: redirects }, 201);
    }
    if (url.pathname === "/validate-client") {
      const client = await this.state.storage.get("client:" + (body.client_id || ""));
      const ok = !!client && client.redirectUris.includes(body.redirect_uri);
      return json({ ok }, ok ? 200 : 400);
    }
    if (url.pathname === "/authorize") {
      const client = await this.state.storage.get("client:" + (body.client_id || ""));
      if (!client || !client.redirectUris.includes(body.redirect_uri) || !body.code_challenge || !body.principal) return json({ error: "Invalid OAuth authorization request." }, 400);
      const code = await opaqueToken("mike_code");
      await this.putExpiring("code:" + await sha256base64url(code), {
        clientId: body.client_id,
        redirectUri: body.redirect_uri,
        codeChallenge: body.code_challenge,
        principal: body.principal
      }, Date.now() + 5 * 60 * 1e3);
      return json({ code });
    }
    if (url.pathname === "/token") {
      if (body.grant_type === "authorization_code") {
        if (!body.code || !body.code_verifier || !body.client_id || !body.redirect_uri) return json({ error: "invalid_request", error_description: "code, code_verifier, client_id, and redirect_uri are required." }, 400);
        const key = "code:" + await sha256base64url(body.code);
        const code = await this.state.storage.get(key);
        await this.state.storage.delete(key);
        const challenge = await sha256base64url(body.code_verifier);
        if (!code || code.expiresAt <= Date.now() || code.clientId !== body.client_id || code.redirectUri !== body.redirect_uri || code.codeChallenge !== challenge) return json({ error: "invalid_grant", error_description: "Invalid or expired authorization code." }, 400);
        return json(await this.issueTokens(code.principal, code.clientId));
      }
      if (body.grant_type === "refresh_token") {
        if (!body.refresh_token) return json({ error: "invalid_request", error_description: "refresh_token is required." }, 400);
        const key = "refresh:" + await sha256base64url(body.refresh_token);
        const refresh = await this.state.storage.get(key);
        await this.state.storage.delete(key);
        if (!refresh || refresh.expiresAt <= Date.now() || body.client_id && refresh.clientId !== body.client_id) return json({ error: "invalid_grant", error_description: "Invalid or expired refresh token." }, 400);
        return json(await this.issueTokens(refresh.principal, refresh.clientId));
      }
      return json({ error: "unsupported_grant_type" }, 400);
    }
    if (url.pathname === "/validate") {
      if (!body.access_token) return json({ error: "invalid_token" }, 401);
      const access = await this.state.storage.get("access:" + await sha256base64url(body.access_token));
      if (!access || access.expiresAt <= Date.now()) return json({ error: "invalid_token" }, 401);
      return json({ principal: access.principal, client_id: access.clientId });
    }
    return new Response("not found", { status: 404 });
  }
  async alarm() {
    const now = Date.now();
    const rows = await this.state.storage.list();
    let next = null;
    for (const [key, value] of rows) {
      if (key === "nextExpiry" || !value || !value.expiresAt) continue;
      if (value.expiresAt <= now) await this.state.storage.delete(key);
      else if (next == null || value.expiresAt < next) next = value.expiresAt;
    }
    if (next != null) {
      await this.state.storage.put("nextExpiry", next);
      await this.state.storage.setAlarm(next);
    } else {
      await this.state.storage.delete("nextExpiry");
    }
  }
};
export {
  MikeAuth,
  MikeJob,
  worker_default as default
};
