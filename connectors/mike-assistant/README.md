# Mike Assistant connector

Cloudflare Worker MCP server for asynchronous Mike Legal reviews.

## Request flow

1. `ask_mike` creates a principal-bound Durable Object job and returns immediately.
2. `get_mike_answer` polls that job. Completed reviews are returned in bounded
   15,000-character parts; callers must fetch every reported part.
3. Completed results expire after 72 hours. Failed jobs expire after 24 hours.

An optional `idempotency_key` prevents duplicate jobs for the same authenticated
principal. The Worker never returns a full large answer in one connector response.

## Authentication

The MCP endpoint accepts legacy `MCP_API_KEY` / `MCP_API_KEYS` bearer keys and
OAuth 2.0 authorization-code + PKCE tokens. OAuth clients and one-time codes are
stored in the `MIKE_AUTH` Durable Object; access tokens expire after 24 hours and
rotating refresh tokens after 30 days. Redirect URIs must be pre-registered and
use HTTPS, except for localhost development callbacks.

Set secrets with `wrangler secret put <NAME>`:

- `MCP_API_KEY`
- `MCP_API_KEYS` (optional, comma-separated)
- `CONNECTOR_API_KEY`
- `MIKE_BACKEND_URL`

Do not restore the retired Supabase username/password variables. The Worker calls
the backend with the narrowly scoped connector service key.

## Verify and deploy

```sh
node --test worker.test.mjs
npx wrangler deploy --keep-vars
```

The `v2` Durable Object migration creates `MikeAuth`; deploy from this directory
so Wrangler reads the checked-in binding and migration declarations.
