# Mike — Backend

Node.js / Express / TypeScript backend for the Mike legal AI platform.

## Local development

```bash
cd backend
cp .env.example .env   # fill in provider keys — SAKANA_API_KEY is not required
npm install
npm run dev
```

The server starts on `http://localhost:3001` by default.

---

## LLM routing

Streaming chat defaults to `claude-fable-5-1` → `claude-opus-5-5` → `gpt-6-astra`. The legal council is four seats: Fable 5.1, GPT-6 Astra, `gemini-3.1-pro-preview`, and Grok 4.7. Opus 5.5 is the judge and is not a voting seat. Minimum quorum defaults to 4.

`SAKANA_API_KEY` is optional. The process does not exit when it is missing, and council/chat do not call Sakana. DeepSeek is not offered in the model picker.

`SPONSOR_CI_MODE=1` fences Sakana and DeepSeek from chat, council, and the judge even when an API key is set, keeps those seats on the frontier ids above, and applies the export attribution gate to plain-text and other downloads as well as Word and PDF. There is no per-organisation settings column. See `docs/OPERATIONS.md`.

Assistant messages store `provider_metadata` for the model that actually answered. Abort/error rows that never reached a provider use `unknown`.
