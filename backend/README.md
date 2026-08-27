# Mike — Backend

Node.js / Express / TypeScript backend for the Mike legal AI platform.

## Local development

```bash
cd backend
cp .env.example .env   # fill in your keys — minimum: SAKANA_API_KEY
npm install
npm run dev
```

The server starts on `http://localhost:3001` by default.

---

## LLM routing

The default first model is **Sakana Fugu Ultra** (`fugu-ultra-20260615`). A deterministic intent classifier (message / named tool — not an LLM router) starts high-stakes paste-into-contract work (`draft_redlines`, `review_against_playbook`, `draft_contract`, a novel pathway that will be signed) on Opus 4.8. Default, cheap, and unsure questions stay on Fugu Ultra. The health-aware fallback pool is Fugu Ultra → Fable 5 → Opus 4.8 → GPT-5.6 Sol. `convene_council` remains an explicit tool.

### Why Fugu?

Fugu Ultra achieves top-tier performance on legal reasoning benchmarks while offering a predictable cost model, making it a strong fit for the Mike platform's document-intensive workloads.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SAKANA_API_KEY` | **Yes** | — | Sakana API key. The server exits at startup if this is missing. Set it in Railway → Service → Variables. Never commit the value. |
| `SAKANA_BASE_URL` | No | `https://api.sakana.ai/v1` | Sakana API base URL. Override only when using a private endpoint or proxy. |
| `SAKANA_MODEL` | No | `fugu-ultra-20260615` | Which Fugu model to use. Applies to all requests. |

### How it works

`src/lib/llm/index.ts` unconditionally delegates to `streamSakana()` / `completeSakanaText()` in `sakana.ts`. The adapter:

1. Resolves the model from `SAKANA_MODEL` (or the default).
2. Builds an OpenAI Chat Completions-style request and streams it from `https://api.sakana.ai/v1/chat/completions`.
3. Runs an agentic tool loop (up to 10 iterations) to handle function calls.
4. Returns `{ fullText, providerMetadata }` — where `providerMetadata` carries `provider_name: "sakana_fugu"`, `model_name`, and the response ID.

**Fugu uses the standard OpenAI Chat Completions API** (`POST /v1/chat/completions`), not the OpenAI Responses API used by the existing `openai.ts`. Key differences:
- **Stateless**: full message history sent on every request.
- **Streaming**: standard SSE chunks with `choices[].delta.content`.

### Provenance logging

Every assistant message written to `chat_messages` includes:

```jsonc
{
  "provider_metadata": {
    "provider_name": "sakana_fugu",
    "model_name": "fugu-ultra-20260615"
  }
}
```

This requires a `provider_metadata JSONB` column in the `chat_messages` table. Apply the included Supabase migration before deploying:

```bash
supabase db push   # or apply supabase/migrations/20260623000000_add_provider_metadata.sql manually
```

### Known gaps

- **Tool calling**: Fugu's function-calling support has not been verified against a live endpoint. If document-editing tools fail silently, check whether the API returns `finish_reason: "tool_calls"` in streaming chunks.
- **Thinking / reasoning**: The `enableThinking` parameter is currently ignored.

### Pricing (as of 2026-06-23)

| Model | Input | Output |
|---|---|---|
| `fugu-ultra-20260615` | $5 / M tokens | $30 / M tokens |
| `fugu-20260615` | (see Sakana pricing page) | |

### Running the tests

```bash
cd backend
npx vitest run src/lib/llm/__tests__/sakana.test.ts
```

> Tests mock the `fetch` global — no API keys required.

### Railway deployment

1. In Railway → Service → Variables, set `SAKANA_API_KEY` to your key from the Sakana dashboard.
2. Optionally set `SAKANA_MODEL` to override the default model.
3. Remove any legacy `FUGU_API_KEY` and `LLM_PROVIDER` variables after this PR merges — they are no longer read.
4. Apply the Supabase migration to add the `provider_metadata` column before the first deploy.
