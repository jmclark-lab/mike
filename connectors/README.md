# Mike MCP connectors (Cloudflare Workers)

These are the two Cloudflare Workers that expose Mike and Fugu Ultra as MCP
servers (OAuth + `/mcp` JSON-RPC, plus an async submit→poll job pattern backed
by a Durable Object). They were previously edited only in the Cloudflare
dashboard; they now live here so they are reviewable, diffable, and deployable.

| Worker | Tools | Backing service |
|--------|-------|-----------------|
| `mike-assistant` | `ask_mike`, `get_mike_answer` | Mike backend `/chat` (Railway) via a Supabase-authed JWT |
| `fugu-assistant` | `ask_fugu`, `ask_fugu_ultra`, `get_fugu_answer` | Sakana Fugu API |

> `worker.js` in each folder is the deployed bundle (esbuild output). It is
> committed as-is so the running code is version-controlled; a future cleanup
> can split it back into readable modules.

## Deploy

```bash
cd connectors/mike-assistant      # or fugu-assistant
wrangler deploy --keep-vars       # --keep-vars preserves dashboard-set vars
```

`--keep-vars` keeps plaintext vars set in the dashboard; secrets are always
retained across deploys. The `wrangler.toml` declares the Durable Object
migration, KV binding (fugu), and cron (fugu) so they are not dropped on deploy.

## Secrets (set via `wrangler secret put <NAME>`, never committed)

- **mike-assistant:** `MCP_API_KEY`, `MIKE_BACKEND_URL`, `CONNECTOR_API_KEY` (service key sent as `X-Connector-Key` to the backend; must match the backend's `CONNECTOR_API_KEY`). As of v1.5.0 the Worker no longer logs in to Supabase, so `MIKE_SUPABASE_URL`, `MIKE_SUPABASE_ANON_KEY`, `MIKE_EMAIL`, and `MIKE_PASSWORD` are obsolete and should be removed.
- **fugu-assistant:** `MCP_API_KEY`, `SAKANA_API_KEY`, `ASSISTANT_PASSPHRASE`

## Known follow-ups

- **Auth hardening (done, v1.5.0):** `mike-assistant` now authenticates to the
  backend with a rotatable `CONNECTOR_API_KEY` (`X-Connector-Key`) mapped to a
  service user on the backend (`connectorOrAuth`); no Supabase password in the Worker.
  Follow-up: rotate the old Supabase account password, since it previously lived here.
- **Timeouts (done):** both alarms use idle-based aborts — mike-assistant
  90s idle / 25-min ceiling; fugu-assistant streams with 90s idle / 20-min ceiling.
