# Mike — Operations Runbook

Operational reference for the bioaccess® **Mike Legal AI** platform. Covers topology, deploy flow, rollback, auth/security, observability, and the gotchas learned in production.

_Last updated: 2026-09-23._

---

## 1. Topology

| Component | What / where |
|-----------|--------------|
| **Backend API** | Node/Express (TypeScript). Railway project **`loyal-acceptance`**. Repo `jmclark-lab/mike` (`/backend`). Prod URL `https://loyal-acceptance-production-26b4.up.railway.app`. |
| **Frontend** | In `/frontend`. Uses Supabase **only for auth** (no direct DB table reads — all data via the backend API). |
| **Database + auth** | Supabase. Prod project **`mike-legal`** (ref `xpyuygerppzdzgvqpwdj`). Staging project **`mike-legal-staging`** (ref `jogvoukazkjvvghhkgql`). |
| **MCP connectors** | Cloudflare Workers (account `4a6ee759ca55f608f82c2cbd2c12d4e2`): **`mike-assistant`** (`ask_mike`/`get_mike_answer`) and **`fugu-assistant`** (`ask_fugu`/`ask_fugu_ultra`/`get_fugu_answer`). Source version-controlled in `/connectors`. |
| **LLM providers** | Anthropic (Fable 5.1 primary, Opus 5.5 judge/fallback, plus older Opus/Sonnet/Haiku picks), OpenAI (GPT-6 Astra default; Sol selectable), Gemini, xAI Grok 4.7. DeepSeek adapter remains but is hidden from the CI-facing picker. Sakana is not on council or the chat chain. |

## 2. Environments & branches

- **Production** — Railway env `production` in `loyal-acceptance`, deploys from **`main`**. Uses the `mike-legal` Supabase project.
- **Staging** — Railway env `staging`, deploys from **`staging`** branch. Uses the **isolated** `mike-legal-staging` Supabase project. Staging URL `https://loyal-acceptance-staging.up.railway.app`. Test user `staging@bioaccessla.com`.
- **Guardrail:** staging must never point at the prod Supabase project. When forking a Railway env, variables are copied — you MUST override `SUPABASE_URL` **and** `SUPABASE_SECRET_KEY` together (see Gotchas).

## 3. Deploy flow

1. Branch off `main`, open a pull request, and require **CI** before merge. CI typechecks, runs backend and connector tests, and blocks high-severity production dependency advisories.
2. Push the accepted commit to **`staging`**. With Railway's **Wait for CI** setting enabled, staging deploys only after GitHub checks pass; the staging smoke test then polls `/healthz` until it reports `status:ok` on that commit.
3. Open a PR **`staging → main`**; CI typechecks it.
4. Merge to **`main`** → Railway auto-deploys production.

**Backend (Railway)** uses `/backend/railway.toml` and a checked-in Dockerfile. The config selects the Docker builder, `/healthz`, bounded restart behavior, and graceful overlap/draining. The service's Railway config-file path must be `/backend/railway.toml`.

**Connectors (Cloudflare)** deploy separately: from `/connectors/<worker>/`, run `wrangler deploy --keep-vars` (preserves dashboard vars; secrets always retained). Migrations/KV/cron are declared in each `wrangler.toml`.

**How changes get pushed (no GitHub write via MCP):** the Cowork GitHub connector is read-only. Deploy backend via the `gh`-authenticated CLI on the Mac (`git push`); deploy connectors via `wrangler`.

## 4. LLM routing

- **Default chain (streaming chat):** `claude-fable-5-1` → `claude-opus-5-5` → `gpt-6-astra`. Documented env: `LLM_MODEL=claude-fable-5-1`, `LLM_FALLBACK_MODEL=claude-opus-5-5,gpt-6-astra`. Fugu / any Sakana model is **not** in the chain. `fugu-` ids named in `LLM_MODEL` or `LLM_FALLBACK_MODEL` are dropped.
- **Overrides:** `LLM_MODEL` replaces the primary. `LLM_FALLBACK_MODEL` replaces the tail (comma-separated model ids, tried in order). These are the only env vars that compose the chat chain. Stream chat uses `resolveModelChain()` / `LLM_MODEL`, not ModelToggle. `SAKANA_MODEL` does not compose the chain.
- **`LLM_PROVIDER` is not a routing lever.** It does not select the primary or add hops.
- **Empty responses count as failures** and advance the chain (root cause of the original outage: a model returned empty without throwing).
- **Health-aware routing:** a model that returns empty/errors goes on an exponential-backoff cooldown (60s → cap 15min, +jitter, reset on success) and is deprioritised — never removed. In-memory/per-process (resets on deploy).
- **Completions** (chat titles, tabular): `completeText` uses the caller's requested (cheap) model as primary with the chain as fallback. `invokeComplete` routes Claude/Gemini/OpenAI/xAI/DeepSeek. Sakana ids throw before any network call. DeepSeek is not added to `resolveModelChain()` and is not a council seat.
- **DeepSeek:** adapter remains (`DEEPSEEK_API_KEY`, optional `DEEPSEEK_BASE_URL`, default `https://api.deepseek.com`). It is fenced out of the CI-facing model picker and account model dropdowns. Not a council seat. With `SPONSOR_CI_MODE=1` it also cannot be selected by id or used as a chat, council, or judge model.
- **Sponsor-CI mode:** see §14. In production (`NODE_ENV=production`, which `backend/Dockerfile` sets) a missing flag stays on. Outside production it is off unless `SPONSOR_CI_MODE=1`. It does not change model-id defaults; it fences Sakana and DeepSeek and keeps council, judge, and the chat chain on the frontier seats already configured above.
- **Legal council:** four provider-diverse seats always fan out — Fable 5.1 (`claude-fable-5-1`), GPT-6 Astra (`gpt-6-astra` with `xhigh` reasoning), Gemini 3.1 Pro Preview (`gemini-3.1-pro-preview`), and Grok 4.7 (`grok-4.7`). Sakana is not a seat. Each original model is retried up to `COUNCIL_MEMBER_MAX_ATTEMPTS` (default 3) without substitution. Quorum is `respondedCount >= COUNCIL_MIN_QUORUM` (default **4**, clamp 1–4; per-call `min_quorum` overrides). The Opus 5.5 judge (`COUNCIL_JUDGE=claude-opus-5-5`, default `COUNCIL_JUDGE_MAX_TOKENS=16000`) is never a voting seat and is never invoked below min quorum. If some seats fail but min quorum is met, the judge reconciles only successful opinions and the header reports `k/4`, not a fake 4/4. Below min quorum, `convene_council` returns a structured dump of completed opinions plus failed-seat errors. Default output budgets: Anthropic/Fable `32000`, Astra `16384`, Gemini `6000`, Grok `8000`. Tunable via `COUNCIL_ANTHROPIC_MAX_TOKENS`, `COUNCIL_OPENAI_MAX_TOKENS`, `COUNCIL_GEMINI_MAX_TOKENS`, `COUNCIL_XAI_MAX_TOKENS`, and `COUNCIL_JUDGE_MAX_TOKENS`. `SAKANA_API_KEY` is not required to boot.
- **Gemini seat:** the council keeps `gemini-3.1-pro-preview`, the strongest Gemini Pro id already in this repo. `gemini-3.5-flash` is present and is not a Pro seat. No Gemini 3.5 Pro API id is checked in. On release, verify the identifier, set `COUNCIL_GEMINI_MODEL` and `COUNCIL_GEMINI_LABEL`, and smoke-test a real 4/4 council before promoting.
- **Backend streams with a 20s SSE keepalive** so long/dense generations aren't cut by the connector's idle timeout. The HTTP server `requestTimeout` / `headersTimeout` / socket `timeout` are **2 hours** (Node 18+ otherwise defaults to 5 minutes and closed `/chat` SSE mid-council).
- **Council completion guard:** a connector job that requested a council (`convene` / `five-seat` / `min_quorum`) is never marked `completed` with the chat-model intake preamble as `answer`. Seats always fan out (or the job fails with a clear error); the judge synthesis or quorum-failure dump is what lands in `answer`. Chat orchestrator `CLAUDE_CHAT_MAX_TOKENS` defaults to **32000** (thinking counts against it); `max_tokens` with no `tool_use` fails the stream instead of returning the preamble. Abort writes an SSE `error` so the connector cannot treat a partial close as `done`. Logs: `[council.telemetry]` (seat dispatch + each seat return length/error) and `[council.completion]` (aggregation / completion-marker call site, answer bytes, source `preamble|synthesis|quorum_failure`).
- **Web grounding:** SerpApi is selective by default (`SERP_SEARCH_MODE=selective`). Fresh/current questions and explicit web-research requests can search; confidential or document-heavy prompts do not leave Mike verbatim. Explicit research over confidential material is reduced to public topic terms. `always` expands search for non-confidential prompts; `off` disables it. Results are cached for 10 minutes, bounded by `SERPAPI_MAX_SEARCHES_PER_MINUTE` (default 30 per process), ranked toward official domains, and injected as untrusted evidence.

## 5. Connectors (Cloudflare Workers)

- Async **submit → poll** job pattern backed by Durable Objects. `ask_*` returns a principal-bound `job_id`; poll `get_*_answer`. Mike results are split into 15,000-character parts and expire after 72 hours (failed jobs after 24 hours). Prompts are stored in R2 (`MIKE_PROMPTS`) with UTF-8 byte DO-chunk fallback (v1.8.1+). Worker **v1.8.2** refuses to finalize a council job whose `answer` is only the intake preamble.
- **Timeouts:** `mike-assistant` uses idle-based abort (90s of silence) with a 25-min ceiling; `fugu-assistant` streams with 90s idle / 20-min ceiling.
- **Auth (mike-assistant → backend):** sends header `X-Connector-Key` = `CONNECTOR_API_KEY`. Backend `connectorOrAuth` middleware maps a valid key to the service user `CONNECTOR_USER_ID` and skips the Supabase JWT. **The key must be identical in Cloudflare (Worker secret) and Railway (backend var).**
- Dense reviews legitimately take up to ~25 min end-to-end; that's expected, not a hang.

## 6. Auth & data security

- Backend does **all** DB access with the Supabase **service-role key** (`SUPABASE_SECRET_KEY`), which bypasses RLS.
- **RLS is enabled (default-deny, no policies) on all `public` tables** — defense-in-depth; the service role still has full access, and the frontend never queries tables directly. If you add a table, enable RLS on it too.
- `provider_metadata` on `chat_messages` records the **actual** answering model per message. Existing keys stay stable: `provider_name`, `model_name`, optional `provider_response_id`. Streaming chat also persists the routing trail: `fallback_depth` (0 = first attempted hop answered), `attempted_models[]` (ids tried, including the answering model), and `skipped_models[]` (each `{ provider_name, model_name, failure_class, failure_reason }`). Abort/error rows that never produced provider metadata stamp `provider_name`/`model_name` `unknown`.

## 7. Observability

- **`GET /healthz`** — unauthenticated. DB check + uptime + deployed `commit` + live routing/cooldown state + boolean `sponsorCiMode` (same `isSponsorCiMode()` as `GET /user/profile`); returns 503 if the DB is down. (There's also a trivial `GET /health` → `{ok:true}`.) `sponsorCiMode` is the effective fence, including when production refused an explicit off.
- **Per-call telemetry** — one JSON line per LLM call: `[llm.telemetry] {event:"llm_call", surface, ok, answered, fallback_depth, attempted[], skipped[], empty, latency_ms, error_class}`. Grep Railway logs, or add a log drain to Axiom/Better Stack and alert when the `fallback_depth>0` share is high. The same trail is stored on `chat_messages.provider_metadata` for stream answers so it is queryable in Supabase without logs.
- **Search telemetry** — `[serp.telemetry]` records outcome, latency, result count, authoritative-source count, and a one-way query hash. Raw search queries and contract text are not logged.
- **Scheduled (Cowork):** daily Mike health-check (8:05am); weekly "Mike model usage" report (Mondays) querying `chat_messages.provider_metadata` in Supabase.
- **Model-usage query:** `select provider_metadata->>'model_name' as model, count(*) from chat_messages where role='assistant' and created_at >= '<date>' group by 1 order by 2 desc;` (only rows after 2026-07-04 reflect the true model).
- **Fallback-analysis query** (rows after this change; older rows lack the trail keys):

```sql
select
  created_at,
  provider_metadata->>'model_name' as answered,
  (provider_metadata->>'fallback_depth')::int as fallback_depth,
  provider_metadata->'attempted_models' as attempted_models,
  provider_metadata->'skipped_models' as skipped_models
from chat_messages
where role = 'assistant'
  and created_at >= now() - interval '7 days'
  and coalesce((provider_metadata->>'fallback_depth')::int, 0) > 0
order by created_at desc;
```

## 8. Rollback

- **Backend:** revert the commit on `main` (or redeploy a previous Railway deployment) — Railway keeps prior builds; redeploying the last-good one is instant and was used successfully during the connector incident.
- **Connector:** `cd /connectors/<worker> && wrangler deploy --keep-vars` from a known-good `worker.js` (the repo holds the deployed versions).
- **RLS (if it ever blocks something):** `alter table public.<table> disable row level security;`.
- **Setting a Railway variable does NOT take effect until you redeploy the service.**

## 9. Gotchas (learned in production)

1. **Railway variable changes require a redeploy** to take effect on the running service. (Caused a connector 401 until redeployed.)
2. **Forking a Railway env copies all variables** — a staging fork kept the *prod* `SUPABASE_SECRET_KEY` while `SUPABASE_URL` pointed at staging → `db:error`. Override both together.
3. **`CONNECTOR_API_KEY` must match** on both Cloudflare and Railway, or the connector 401s.
4. **Pasting a large SQL file into the Supabase editor can apply only part of the trailing block** — after a staging rebuild, verify `select count(*) ... where relrowsecurity` = expected (should be 23).
5. **The repository is the DB schema source of truth.** `backend/schema.sql` is the fresh-database baseline; apply dated files in `backend/migrations/` to existing environments in filename order and record each applied filename.
6. **`wrangler secret delete` only removes secrets, not plaintext vars** (e.g. `MIKE_SUPABASE_URL` must be deleted in the Cloudflare dashboard).
7. **`~/mike` on the ops Mac points at upstream `willchen96/mike`, not the deploy repo** — always deploy against `jmclark-lab/mike`.

## 10. Secrets & key IDs (names only — values in dashboards)

- **Backend (Railway):** `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY` (adapter only; not in the picker, default chat chain, or council), `SAKANA_API_KEY` (optional; not required to boot; council and chat do not call Sakana), `LLM_MODEL` (optional primary override), `LLM_FALLBACK_MODEL` (optional comma-separated tail override), `CONNECTOR_API_KEY`, `CONNECTOR_USER_ID`, `FRONTEND_URL`, `USER_API_KEYS_ENCRYPTION_SECRET`, `SERPAPI_KEY`, optional `SERP_SEARCH_MODE` / `SERPAPI_MAX_SEARCHES_PER_MINUTE`, `SPONSOR_CI_MODE` (production expects `1`; when `NODE_ENV=production` an unset value stays on), `SPONSOR_CI_CHANGE_CONTROL_NOTE` (required only to honor an explicit production off), R2/download vars, etc.
- **mike-assistant (Cloudflare):** `CONNECTOR_API_KEY`, `MCP_API_KEY`, `MIKE_BACKEND_URL`.
- **fugu-assistant (Cloudflare):** `MCP_API_KEY`, `SAKANA_API_KEY`, `ASSISTANT_PASSPHRASE`.
- **Prod connector service user id:** `CONNECTOR_USER_ID = c62f4b5c-db2d-44c0-a6ad-5a7cc7c1cf12` (jmclark@bioaccessla.com).

## 11. Open items (owner: Julio)

- Rotate the old Supabase account password (it previously lived in the Worker).
- Delete the `MIKE_SUPABASE_URL` plaintext var on the `mike-assistant` Worker (Cloudflare dashboard).
- Point an external monitor (UptimeRobot / Better Stack) at prod `/healthz`.
- Give staging its own distinct `CONNECTOR_API_KEY` if/when a staging connector Worker is created.

## 12. Related docs (project folder)

`Mike_Architecture_Roadmap.md` (prioritized roadmap + Mike's second opinion) · `Staging_Setup_Plan_for_Comet.md` · `Staging_Schema.sql` · `EFS_v0.4_Review_MIKE.md` / `EFS_v0.4_Review_bioaccess.md` · `Flux_Robotics_EFS_Protocol_Synopsis_v0.5.docx`.

## 13. Outbound attribution (company voice)

Sponsor-facing Word, PDF, and download links must not attribute the work to Mike or an AI tool. The chat persona can still be Mike.

- **Company voice** is `user_profiles.organisation` (Account → Organisation). There is no tenant table. bioaccess, Amavita Research, Amavita Practice, and Amavita Sciences each keep their own name. `TRACKED_CHANGE_AUTHOR` is used only when that field is empty or is a banned label. Otherwise the Word author is `Author`. A missing organisation never emits Mike or AI.
- **Do not bulk-assign one company name.** Migration `20260923_01_user_profile_organisation_company_voice.sql` only clears banned labels (Mike, AI, legal assistant, and the same set the app rejects). It leaves real names and NULL rows alone. Backfill NULL rows only after the company name is confirmed:

```sql
update public.user_profiles
set organisation = 'bioaccess', updated_at = now()
where user_id = '<uuid>'
  and organisation is null;
```

  Or, from `/backend`: `npx tsx src/scripts/bootstrapOrganisation.ts --list-missing` then `--user-id <uuid> --organisation "bioaccess"`. The script refuses banned labels and will not replace a safe name unless `--force` is passed. It prints user ids only.
- **Export gate.** Downloads (`/download/:token`, `/single-documents/:id/export`, `/single-documents/:id/url`, `/single-documents/:id/docx`, zip, inline docx/PDF) scrub known disclosure phrases and then reject the file with HTTP 422 `outbound_attribution_blocked` if any remain in body text, footnotes, comments, headers/footers, tracked-change authors, or Word core creator / lastModifiedBy. Library `GET /url` loads the stored object and runs that same gate **before** `getSignedUrl`. It mints a URL only when the object that will be fetched is already the gated bytes. A scrub that would change the stored file is a 422: the signed URL is not issued and the dirty bytes are not streamed. `GET /docx` streams the gated bytes (scrubbed when the scrub succeeds) and returns the same 422 instead of the original file when anything remains. Word, PDF, and legacy `.doc` fail closed even when Sponsor-CI mode is off. A missing or wrong filename does not skip the gate: zip / PDF / OLE magic bytes select it. If a Word file's PDF rendition fails the gate, that PDF is not sent and the viewer is given the gated docx instead. A PDF original that fails is rejected. Ordinary prose such as "Mike Smith" or "the AI vendor clause" is left in place.
- **Legacy authors.** Opening a docx (viewer, edit, upload, accept/reject) rewrites `w:author` values, plus banned `dc:creator` / `cp:lastModifiedBy`, to the organisation or `Author`. "Mike Smith" is not rewritten. Body text is not rewritten and no personal name is invented. To fix stored files that have not been opened: `npx tsx src/scripts/rewriteBannedDocxAuthors.ts` (dry-run) and the same command with `--apply`. This does not deploy by itself.

## 14. Sponsor-CI mode

Production expects both flags on:

- `SPONSOR_CI_MODE=1` on the backend process (`true`, `yes`, and `on` also count).
- `NEXT_PUBLIC_SPONSOR_CI_MODE=1` on the frontend build.

`NEXT_PUBLIC_SPONSOR_CI_MODE` is inlined at **build time**. A later Railway variable edit does not change a frontend that was already built. The backend `SPONSOR_CI_MODE` value, read when the API process is running, is what refuses Sakana, DeepSeek, and the plain-text export bypass. The two can drift until the frontend is rebuilt. `GET /healthz` (no auth) and `GET /user/profile` both report the backend flag as `sponsorCiMode`.

Production is `NODE_ENV=production`. `backend/Dockerfile` sets that on the runtime image, so every Railway deploy of this image (production and staging) is in that mode. Local `npm run dev` and unit tests are not, unless you set `NODE_ENV` yourself.

| `NODE_ENV` | `SPONSOR_CI_MODE` | `SPONSOR_CI_CHANGE_CONTROL_NOTE` | Result |
|---|---|---|---|
| production | unset, empty, or anything other than an explicit off | ignored | **ON** |
| production | `1` / `true` / `yes` / `on` | ignored | **ON** |
| production | `0` / `false` / `off` / `no` | missing or blank | **ON** (OFF refused; process still boots; a warning is logged) |
| production | `0` / `false` / `off` / `no` | non-empty note | **OFF** |
| anything else | unset or any value other than `1` / `true` / `yes` / `on` | ignored | **OFF** (unchanged local/dev behavior) |

The process does not refuse to boot. A boot exit would crash-loop the container (`restartPolicyMaxRetries`) and take every tenant on that process down. An explicit production off without a note is not honored.

A Railway variable change does not apply until that service is redeployed. Unsetting `SPONSOR_CI_MODE` and redeploying does **not** turn fencing off on this image.

`user_profiles` has no settings or feature-flag column. `organisation` is the company name used as the Word author, not a mode switch. There is no per-tenant flag to turn Sponsor-CI on for one organisation and off for another. The flag covers every account on the process, including non-sponsor tenants. Set the company name per account (Account → Organisation, or `bootstrapOrganisation.ts`) before sponsor-facing redlines; an empty organisation falls back to `TRACKED_CHANGE_AUTHOR`, then `Author`.

While the mode is on:

- The profile payload includes `sponsorCiMode: true`. The chat model picker and the account model dropdowns drop any `fugu-` or `deepseek-` id. Sakana and DeepSeek are already absent from those lists; the filter is what keeps them out if a key exists.
- Frontend build flag `NEXT_PUBLIC_SPONSOR_CI_MODE=1` applies the same picker filter before the profile loads. The backend flag is what actually refuses the call.
- `resolveModel` will not return a Sakana or DeepSeek id. `completeText` / `completeTextStrict` / streaming throw before the adapter, so a configured `DEEPSEEK_API_KEY` or `SAKANA_API_KEY` is not used.
- Council seat env overrides (`COUNCIL_ANTHROPIC_MODEL`, `COUNCIL_OPENAI_MODEL`, `COUNCIL_GEMINI_MODEL`, `COUNCIL_XAI_MODEL`) and `COUNCIL_JUDGE` are ignored. Seats stay Fable 5.1, GPT-6 Astra, Gemini 3.1 Pro Preview, and Grok 4.7. The judge stays Opus 5.5. Token budgets can still be tuned.
- The chat chain drops Sakana, DeepSeek, and any other id outside that frontier set, and always keeps `claude-fable-5-1` → `claude-opus-5-5` → `gpt-6-astra`.
- Export and download routes, including Library `GET /single-documents/:id/url` and `GET /single-documents/:id/docx`, fail closed on `.docx`, `.pdf`, and `.doc` with HTTP 422 `outbound_attribution_blocked`. `/url` does not mint a signed storage URL unless the stored object already matches the gated bytes. `/docx` streams those gated bytes and does not send the original when the gate rejects it. Sponsor-CI also scans `.txt` and every other filename on these routes, so renaming a file cannot skip the gate. With the mode off, those other types still pass through and the Word/PDF gate stays as shipped.

Known limits: a counterparty PDF that says "legal assistant" in ordinary prose is rejected. The exact author label `Mike` is rewritten; `Mike Smith` is not. The operator has to set each account's organisation; the mode does not fill one in.
