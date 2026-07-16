# Mike — Operations Runbook

Operational reference for the bioaccess® **Mike Legal AI** platform. Covers topology, deploy flow, rollback, auth/security, observability, and the gotchas learned in production.

_Last updated: 2026-07-15._

---

## 1. Topology

| Component | What / where |
|-----------|--------------|
| **Backend API** | Node/Express (TypeScript). Railway project **`loyal-acceptance`**. Repo `jmclark-lab/mike` (`/backend`). Prod URL `https://loyal-acceptance-production-26b4.up.railway.app`. |
| **Frontend** | In `/frontend`. Uses Supabase **only for auth** (no direct DB table reads — all data via the backend API). |
| **Database + auth** | Supabase. Prod project **`mike-legal`** (ref `xpyuygerppzdzgvqpwdj`). Staging project **`mike-legal-staging`** (ref `jogvoukazkjvvghhkgql`). |
| **MCP connectors** | Cloudflare Workers (account `4a6ee759ca55f608f82c2cbd2c12d4e2`): **`mike-assistant`** (`ask_mike`/`get_mike_answer`) and **`fugu-assistant`** (`ask_fugu`/`ask_fugu_ultra`/`get_fugu_answer`). Source version-controlled in `/connectors`. |
| **LLM providers** | Anthropic (Fable 5, Opus 4.8, Sonnet, Haiku), Sakana (Fugu / Fugu Ultra), plus Gemini/OpenAI adapters. |

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

- **Chain (streaming chat):** `claude-fable-5` → `fugu-ultra-20260615` → `claude-opus-4-8`. Configurable via `LLM_MODEL` (primary) and `LLM_FALLBACK_MODEL` (comma-separated tail).
- **Empty responses count as failures** and advance the chain (root cause of the original outage: a model returned empty without throwing).
- **Health-aware routing:** a model that returns empty/errors goes on an exponential-backoff cooldown (60s → cap 15min, +jitter, reset on success) and is deprioritised — never removed. In-memory/per-process (resets on deploy).
- **Completions** (chat titles, tabular): `completeText` uses the caller's requested (cheap) model as primary with the chain as fallback. `invokeComplete` routes Claude/Gemini/OpenAI/Sakana.
- **Backend streams with a 20s SSE keepalive** so long/dense generations aren't cut by the connector's idle timeout.

## 5. Connectors (Cloudflare Workers)

- Async **submit → poll** job pattern backed by Durable Objects. `ask_*` returns a principal-bound `job_id`; poll `get_*_answer`. Mike results are split into 15,000-character parts and expire after 72 hours (failed jobs after 24 hours).
- **Timeouts:** `mike-assistant` uses idle-based abort (90s of silence) with a 25-min ceiling; `fugu-assistant` streams with 90s idle / 20-min ceiling.
- **Auth (mike-assistant → backend):** sends header `X-Connector-Key` = `CONNECTOR_API_KEY`. Backend `connectorOrAuth` middleware maps a valid key to the service user `CONNECTOR_USER_ID` and skips the Supabase JWT. **The key must be identical in Cloudflare (Worker secret) and Railway (backend var).**
- Dense reviews legitimately take up to ~25 min end-to-end; that's expected, not a hang.

## 6. Auth & data security

- Backend does **all** DB access with the Supabase **service-role key** (`SUPABASE_SECRET_KEY`), which bypasses RLS.
- **RLS is enabled (default-deny, no policies) on all `public` tables** — defense-in-depth; the service role still has full access, and the frontend never queries tables directly. If you add a table, enable RLS on it too.
- `provider_metadata` on `chat_messages` records the **actual** answering model per message (was previously hardcoded).

## 7. Observability

- **`GET /healthz`** — DB check + uptime + deployed `commit` + live routing/cooldown state; returns 503 if the DB is down. (There's also a trivial `GET /health` → `{ok:true}`.)
- **Per-call telemetry** — one JSON line per LLM call: `[llm.telemetry] {event:"llm_call", surface, ok, answered, fallback_depth, attempted[], empty, latency_ms, error_class}`. Grep Railway logs, or add a log drain to Axiom/Better Stack and alert when the `fallback_depth>0` share is high.
- **Scheduled (Cowork):** daily Mike health-check (8:05am); weekly "Mike model usage" report (Mondays) querying `chat_messages.provider_metadata` in Supabase.
- **Model-usage query:** `select provider_metadata->>'model_name' as model, count(*) from chat_messages where role='assistant' and created_at >= '<date>' group by 1 order by 2 desc;` (only rows after 2026-07-04 reflect the true model).

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

- **Backend (Railway):** `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `SAKANA_API_KEY`, `SAKANA_MODEL`, `LLM_MODEL`, `CONNECTOR_API_KEY`, `CONNECTOR_USER_ID`, `FRONTEND_URL`, `USER_API_KEYS_ENCRYPTION_SECRET`, R2/download vars, etc.
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
