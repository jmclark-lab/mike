# Frontend (mike-legal Worker) deploy

The frontend is deployed manually (there's no Workers Builds and no deploy Action). Config: `frontend/wrangler.jsonc`.

1. Check out the commit that is live on Railway (`/healthz` `commit`).
2. Set the build-time public values (Next.js inlines them at build time; never commit real values):
   ```
   NEXT_PUBLIC_SUPABASE_URL=<supabase project url>
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<supabase publishable/anon key>
   NEXT_PUBLIC_API_BASE_URL=<backend base url>
   # optional: NEXT_PUBLIC_SPONSOR_CI_MODE=true
   ```
3. `cd frontend && npm ci && npx opennextjs-cloudflare build`
4. `CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler deploy --keep-vars --message "<short sha>"` (needs Node 22+ and `CLOUDFLARE_API_TOKEN` with Workers edit).
5. Verify: the new version in the Worker's deployments, `/` and `/login` return 200, and the backend `/healthz` is ok.

`--keep-vars` keeps the dashboard vars. Secrets (`SUPABASE_SECRET_KEY`) are always kept.
Rollback: `npx wrangler rollback <previous version id>`.
