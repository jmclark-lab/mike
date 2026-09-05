# Golden eval harness (LATAM legal / regulatory)

Minimal v1 suite so Mike can compare **main-model upgrades** on the work bioaccess® actually does: LATAM clinical-trial contracts (CTA / MSA / WO style) and INVIMA / COFEPRIS / ANVISA-style regulatory judgment.

This is **opt-in**. Default `npm test` only validates fixtures and scoring offline. It never calls paid APIs.

## Layout

| Path | Purpose |
| --- | --- |
| `fixtures/*.md` | 30 golden cases (15 contract, 15 regulatory) |
| `harness.ts` | Load, validate, keyword-score (no LLM imports) |
| `run.ts` | CLI: `--dry-run`, live `completeText`, optional `--council` |
| `reports/sample-dry-run.md` | Committed dry-run plan |
| `reports/live-*.md` | Live reports (gitignored) |

Each fixture is markdown with YAML frontmatter:

- `id` — kebab-case, unique
- `category` — `contract` or `regulatory`
- `question` — the prompt
- `rubric` — what a good answer should do (human-readable)
- `must_mention` / `must_not_claim` — case-insensitive substring checks
- Body — synthetic scenario only (no PHI, no real patient data, synthetic company names)

Country-blind where possible; agency names appear when the case is INVIMA-, COFEPRIS-, or ANVISA-flavored.

## How to run

From the repo root or `backend/` (`--` forwards flags through npm):

```bash
# Validate fixtures + print the plan. No API keys. Safe for CI humans.
npm run eval:golden -- --dry-run

# Live: one main-model completeText call per fixture (not the 5-seat council).
# Requires ANTHROPIC_API_KEY and/or LLM_MODEL (set LLM_MODEL if you are
# pointing at Gemini/OpenAI/etc. instead of Anthropic).
ANTHROPIC_API_KEY=… npm run eval:golden --prefix backend

# Subset (cheaper while iterating)
npm run eval:golden --prefix backend -- --id contract-cta-indemnity-01
npm run eval:golden --prefix backend -- --limit 3

# Optional: full 5-seat council + judge. Documented, not required for green CI.
npm run eval:golden --prefix backend -- --council --limit 1
```

The CLI loads `backend/.env` if present. `--help` prints the same flags.

## What the scores mean

v1 is **keyword / rubric pass rate**, not LLM-as-judge.

A fixture **passes** when:

1. The model returned non-empty text, and
2. Every `must_mention` term appears as a case-insensitive substring, and
3. No `must_not_claim` term appears.

**Pass rate** = passed fixtures / fixtures run. Use the same fixture set when you change `LLM_MODEL` so the rate is comparable.

Limitations (accepted for v1): a correct answer that uses a synonym can fail; a vague answer that happens to include the stems can pass. Raise the bar later with an LLM judge if needed.

## Cost warning

| Mode | Calls | Use |
| --- | --- | --- |
| `--dry-run` | None | Default. Commit/CI-safe. |
| Live (default without `--dry-run`) | 1× `completeText` per fixture on the **active main model** (`LLM_MODEL` or `resolveActiveModel()`, currently Fable 5.1 unless overridden) | Model-upgrade comparisons |
| `--council` | Full **5-seat council + judge** per fixture (`conveneCouncil`) | Occasional high-stakes checks only |

Do **not** put live or council mode on default CI. Thirty live completes are already a noticeable bill; council is a multiple of that.

This harness does **not** change the production default model chain or DeepSeek settings.

## CI

`backend` `npm test` includes `evals/golden/harness.test.ts` (parse, validate, score). It does not import `completeText` and does not read API keys.

`npm run eval:golden` is a separate script.
