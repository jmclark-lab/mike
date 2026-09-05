/**
 * Golden eval harness v1 — load LATAM legal/regulatory fixtures and score
 * answers with keyword/rubric checks. No LLM imports here so `npm test`
 * and `--dry-run` never touch paid APIs.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GOLDEN_CATEGORIES = ["contract", "regulatory"] as const;
export type GoldenCategory = (typeof GOLDEN_CATEGORIES)[number];

export interface GoldenFixture {
  id: string;
  category: GoldenCategory;
  question: string;
  rubric?: string;
  must_mention: string[];
  must_not_claim: string[];
  context: string;
  sourcePath: string;
}

export interface TermHit {
  term: string;
  found: boolean;
}

export interface FixtureScore {
  id: string;
  category: GoldenCategory;
  passed: boolean;
  mentionHits: TermHit[];
  forbiddenHits: TermHit[];
  answerChars: number;
  latencyMs?: number;
  model?: string;
  error?: string;
}

export interface EvalReport {
  mode: "dry-run" | "live" | "council";
  generatedAt: string;
  model?: string;
  fixtures: GoldenFixture[];
  scores?: FixtureScore[];
  passCount: number;
  total: number;
  notes: string[];
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function goldenDirFromMeta(metaUrl: string = import.meta.url): string {
  return dirname(fileURLToPath(metaUrl));
}

export function fixturesDir(goldenDir: string = goldenDirFromMeta()): string {
  return join(goldenDir, "fixtures");
}

export function reportsDir(goldenDir: string = goldenDirFromMeta()): string {
  return join(goldenDir, "reports");
}

export function findRepoRoot(fromDir: string = goldenDirFromMeta()): string {
  return join(fromDir, "..", "..");
}

/** Minimal YAML subset: scalars, `|` / `>` blocks, and dash lists. */
export function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  const out: Record<string, unknown> = {};
  let i = 0;

  const isKey = (line: string) => /^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line);

  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.trimEnd();
    i += 1;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (/^\s/.test(raw)) {
      throw new Error(`unexpected indented line in YAML: ${raw}`);
    }
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`expected key: value, got: ${line}`);
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (rest === "|" || rest === ">") {
      const block: string[] = [];
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim()) {
          block.push("");
          i += 1;
          continue;
        }
        if (!/^\s+/.test(next) && isKey(next.trim())) break;
        if (!/^\s+/.test(next)) {
          throw new Error(`block scalar for "${key}" must be indented`);
        }
        block.push(next.replace(/^\s{2}/, ""));
        i += 1;
      }
      const joined = block.join("\n").replace(/\s+$/, "");
      out[key] = rest === ">" ? joined.replace(/\n+/g, " ").trim() : joined.trim();
      continue;
    }

    if (rest === "") {
      const items: string[] = [];
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim() || next.trimStart().startsWith("#")) {
          i += 1;
          continue;
        }
        const list = next.match(/^\s+-\s+(.*)$/);
        if (!list) break;
        items.push(unquote(list[1].trim()));
        i += 1;
      }
      out[key] = items;
      continue;
    }

    out[key] = unquote(rest);
  }

  return out;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n") && text !== "---") {
    throw new Error("fixture must start with YAML frontmatter (---)");
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new Error("unclosed YAML frontmatter");
  const yaml = text.slice(4, end);
  const body = text.slice(end + 4).replace(/^\n/, "").trim();
  return { data: parseSimpleYaml(yaml), body };
}

function asStringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (Array.isArray(value)) {
    return value.map((item, idx) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error(`${field}[${idx}] must be a non-empty string`);
      }
      return item.trim();
    });
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  throw new Error(`${field} must be a string list`);
}

export function fixtureFromParsed(
  data: Record<string, unknown>,
  body: string,
  sourcePath: string,
): GoldenFixture {
  const id = String(data.id ?? "").trim();
  const category = String(data.category ?? "").trim();
  const question = String(data.question ?? "").trim();
  const rubric =
    typeof data.rubric === "string" && data.rubric.trim()
      ? data.rubric.trim()
      : undefined;

  if (!id) throw new Error("missing id");
  if (!GOLDEN_CATEGORIES.includes(category as GoldenCategory)) {
    throw new Error(`category must be contract|regulatory, got "${category}"`);
  }
  if (!question) throw new Error("missing question");

  return {
    id,
    category: category as GoldenCategory,
    question,
    rubric,
    must_mention: asStringList(data.must_mention, "must_mention"),
    must_not_claim: asStringList(data.must_not_claim, "must_not_claim"),
    context: body,
    sourcePath,
  };
}

export function validateFixture(fixture: GoldenFixture): string[] {
  const errors: string[] = [];
  if (!ID_RE.test(fixture.id)) {
    errors.push(`id "${fixture.id}" must be kebab-case [a-z0-9-]`);
  }
  if (fixture.question.length < 20) {
    errors.push(`question is too short (${fixture.question.length} chars)`);
  }
  if (!fixture.context.trim()) {
    errors.push("body/context is empty — add a synthetic scenario");
  }
  if (/patient\s+\d{2,}|mrn\b|ssn\b|date of birth/i.test(fixture.question + fixture.context)) {
    errors.push("looks like PHI / real patient identifiers — use synthetic facts only");
  }
  return errors;
}

export function loadFixtures(dir: string = fixturesDir()): GoldenFixture[] {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort();
  if (names.length === 0) throw new Error(`no markdown fixtures in ${dir}`);

  const fixtures: GoldenFixture[] = [];
  const ids = new Set<string>();
  for (const name of names) {
    const sourcePath = join(dir, name);
    const raw = readFileSync(sourcePath, "utf8");
    let fixture: GoldenFixture;
    try {
      const { data, body } = parseFrontmatter(raw);
      fixture = fixtureFromParsed(data, body, sourcePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${basename(sourcePath)}: ${msg}`);
    }
    const localErrors = validateFixture(fixture);
    if (localErrors.length) {
      throw new Error(`${basename(sourcePath)}: ${localErrors.join("; ")}`);
    }
    if (ids.has(fixture.id)) {
      throw new Error(`duplicate fixture id "${fixture.id}" in ${name}`);
    }
    ids.add(fixture.id);
    fixtures.push(fixture);
  }
  return fixtures;
}

export function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when `term` appears and is not clearly negated in the preceding window. */
export function containsAffirmativeClaim(text: string, term: string): boolean {
  const haystack = normalizeForMatch(text);
  const needle = normalizeForMatch(term);
  if (!needle) return false;
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return false;
    const window = haystack.slice(Math.max(0, idx - 56), idx);
    const negated =
      /\b(not|never|no|without|cannot|can't|isn't|aren't|don't|do not|does not|did not|is not|are not|was not|were not)\b/.test(
        window,
      );
    if (!negated) return true;
    from = idx + Math.max(needle.length, 1);
  }
  return false;
}

export function scoreAnswer(fixture: GoldenFixture, answer: string): FixtureScore {
  const haystack = normalizeForMatch(answer);
  const mentionHits = fixture.must_mention.map((term) => ({
    term,
    found: haystack.includes(normalizeForMatch(term)),
  }));
  const forbiddenHits = fixture.must_not_claim.map((term) => ({
    term,
    found: containsAffirmativeClaim(answer, term),
  }));
  const mentionsOk = mentionHits.every((hit) => hit.found);
  const forbiddenOk = forbiddenHits.every((hit) => !hit.found);
  const hasText = answer.trim().length > 0;
  return {
    id: fixture.id,
    category: fixture.category,
    passed: hasText && mentionsOk && forbiddenOk,
    mentionHits,
    forbiddenHits,
    answerChars: answer.length,
  };
}

export function filterFixtures(
  fixtures: GoldenFixture[],
  opts: { ids?: string[]; limit?: number },
): GoldenFixture[] {
  let selected = fixtures;
  if (opts.ids?.length) {
    const want = new Set(opts.ids);
    selected = fixtures.filter((f) => want.has(f.id));
    const missing = [...want].filter((id) => !fixtures.some((f) => f.id === id));
    if (missing.length) throw new Error(`unknown fixture id(s): ${missing.join(", ")}`);
  }
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new Error("--limit must be a positive integer");
    }
    selected = selected.slice(0, opts.limit);
  }
  return selected;
}

export function buildUserPrompt(fixture: GoldenFixture): string {
  const parts = [`QUESTION:\n${fixture.question}`];
  if (fixture.context) {
    parts.push(`CONTEXT (synthetic; no real patient data):\n${fixture.context}`);
  }
  if (fixture.rubric) {
    parts.push(`Answer in a way that a careful internal reviewer would find useful.`);
  }
  return parts.join("\n\n");
}

export const GOLDEN_SYSTEM_PROMPT =
  "You are Mike, a legal/regulatory analyst for Latin-American clinical-research " +
  "and market-access work (CRO / sponsor / site contracts and national medicines agencies). " +
  "Answer rigorously and concisely. Flag assumptions and uncertainty. " +
  "Do not fabricate citations, article numbers, approval dates, or contract terms that are not in the prompt. " +
  "Prefer country-agnostic LATAM principles; name a national agency only when the facts identify one. " +
  "This is analysis for internal review, not legal advice. Never say you are giving legal advice.";

export function passRate(passCount: number, total: number): string {
  if (total === 0) return "n/a";
  return `${passCount}/${total} (${Math.round((passCount / total) * 100)}%)`;
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [
    "# Golden eval report",
    "",
    `- Mode: \`${report.mode}\``,
    `- Generated: ${report.generatedAt}`,
    `- Fixtures: ${report.total} ` +
      `(${report.fixtures.filter((f) => f.category === "contract").length} contract, ` +
      `${report.fixtures.filter((f) => f.category === "regulatory").length} regulatory)`,
  ];
  if (report.model) lines.push(`- Model: \`${report.model}\``);
  if (report.mode === "dry-run") {
    lines.push("- Pass rate: n/a (dry-run — fixtures validated, no model calls)");
  } else {
    lines.push(`- Pass rate: ${passRate(report.passCount, report.total)}`);
  }
  if (report.notes.length) {
    lines.push("", "## Notes", "");
    for (const note of report.notes) lines.push(`- ${note}`);
  }

  lines.push("", "## Scoring", "");
  lines.push(
    "v1 scores are **keyword / rubric checks**, not LLM-as-judge. " +
      "A fixture **passes** when the answer is non-empty, every `must_mention` term appears " +
      "(case-insensitive substring), and no `must_not_claim` term appears. " +
      "Use the pass rate to compare model upgrades on the same fixture set.",
  );

  lines.push("", "## Fixtures", "");
  lines.push("| ID | Category | Result | Rubric / keywords |");
  lines.push("| --- | --- | --- | --- |");
  for (const fixture of report.fixtures) {
    const score = report.scores?.find((s) => s.id === fixture.id);
    let result = "planned";
    if (report.mode !== "dry-run") {
      if (!score) result = "missing";
      else if (score.error) result = `error: ${score.error}`;
      else result = score.passed ? "PASS" : "FAIL";
    }
    const keywords = [
      fixture.must_mention.length ? `mention: ${fixture.must_mention.join(", ")}` : "",
      fixture.must_not_claim.length ? `forbid: ${fixture.must_not_claim.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    const detail = [fixture.rubric, keywords].filter(Boolean).join(" — ").replace(/\|/g, "/");
    lines.push(`| \`${fixture.id}\` | ${fixture.category} | ${result} | ${detail} |`);
  }

  if (report.scores?.length && report.mode !== "dry-run") {
    lines.push("", "## Failures", "");
    const failed = report.scores.filter((s) => !s.passed);
    if (!failed.length) {
      lines.push("None.");
    } else {
      for (const score of failed) {
        const missed = score.mentionHits.filter((h) => !h.found).map((h) => h.term);
        const forbidden = score.forbiddenHits.filter((h) => h.found).map((h) => h.term);
        lines.push(`### \`${score.id}\``);
        if (score.error) lines.push(`- Error: ${score.error}`);
        if (missed.length) lines.push(`- Missing must_mention: ${missed.join(", ")}`);
        if (forbidden.length) lines.push(`- Hit must_not_claim: ${forbidden.join(", ")}`);
        lines.push("");
      }
    }
  }

  lines.push("", "## Cost warning", "");
  lines.push(
    "Live mode calls the **main model complete** path once per fixture. " +
      "`--council` convenes the full 5-seat council plus judge — that is several paid calls per fixture and is **not** for CI. " +
      "Default `npm test` never calls this harness in live mode.",
  );
  lines.push("");
  return lines.join("\n");
}

export function summarizePlan(fixtures: GoldenFixture[]): string[] {
  const contract = fixtures.filter((f) => f.category === "contract").length;
  const regulatory = fixtures.filter((f) => f.category === "regulatory").length;
  return [
    `Load ${fixtures.length} fixtures (${contract} contract, ${regulatory} regulatory).`,
    "Validate YAML frontmatter (id, category, question) and synthetic context body.",
    "Dry-run stops here: no LLM calls, write sample markdown report.",
    "Live mode (ANTHROPIC_API_KEY or LLM_MODEL): one completeText call per fixture using the active main model.",
    "Optional --council: conveneCouncil per fixture (expensive; opt-in only).",
    "Score with must_mention / must_not_claim substring checks; pass rate = passed / total.",
  ];
}

export function canRunLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY?.trim() || env.LLM_MODEL?.trim());
}

export interface CliOptions {
  dryRun: boolean;
  council: boolean;
  ids?: string[];
  limit?: number;
  help: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, council: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--council") opts.council = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--limit") {
      const value = argv[i + 1];
      i += 1;
      opts.limit = Number.parseInt(value ?? "", 10);
    } else if (arg.startsWith("--limit=")) {
      opts.limit = Number.parseInt(arg.slice("--limit=".length), 10);
    } else if (arg === "--id") {
      const value = argv[i + 1];
      i += 1;
      opts.ids = (value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith("--id=")) {
      opts.ids = arg
        .slice("--id=".length)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

export const CLI_HELP = `Golden eval harness (LATAM legal/regulatory fixtures)

Usage:
  npm run eval:golden -- --dry-run
  npm run eval:golden --prefix backend -- --dry-run
  npm run eval:golden -- --id contract-cta-indemnity-01
  npm run eval:golden -- --council --limit 1

Flags:
  --dry-run     Validate fixtures and print the plan. No paid API calls.
  --council     Live mode only: 5-seat council + judge (expensive; not for CI).
  --limit N     Run the first N selected fixtures.
  --id id[,id]  Run specific fixture id(s).
  --help        Show this help.

Live mode requires ANTHROPIC_API_KEY and/or LLM_MODEL (or another provider
key plus LLM_MODEL pointing at that provider). Default npm test never runs live.
`;
