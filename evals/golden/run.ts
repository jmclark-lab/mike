#!/usr/bin/env npx tsx
/**
 * CLI for the golden eval harness.
 *
 *   npm run eval:golden -- --dry-run
 *   npm run eval:golden            # live main-model complete when keys present
 *   npm run eval:golden -- --council
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GOLDEN_SYSTEM_PROMPT,
  buildUserPrompt,
  canRunLive,
  CLI_HELP,
  filterFixtures,
  findRepoRoot,
  fixturesDir,
  formatReport,
  goldenDirFromMeta,
  loadFixtures,
  parseCliArgs,
  reportsDir,
  scoreAnswer,
  summarizePlan,
  type EvalReport,
  type FixtureScore,
  type GoldenFixture,
} from "./harness.ts";

const GOLDEN_DIR = goldenDirFromMeta();
const REPO_ROOT = findRepoRoot(GOLDEN_DIR);

/** Load KEY=VALUE files without depending on backend/node_modules resolution. */
function loadEnvFile(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function loadEnvFiles(): void {
  loadEnvFile(join(REPO_ROOT, "backend", ".env"));
  loadEnvFile(join(REPO_ROOT, ".env"));
}

function writeReportFile(filename: string, markdown: string): string {
  const dir = reportsDir(GOLDEN_DIR);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, filename);
  writeFileSync(dest, markdown, "utf8");
  return dest;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function completeMain(fixture: GoldenFixture): Promise<{
  answer: string;
  model: string;
}> {
  const { completeText, resolveActiveModel } = await import(
    "../../backend/src/lib/llm/index.ts"
  );
  const model = resolveActiveModel();
  const answer = await completeText({
    model,
    systemPrompt: GOLDEN_SYSTEM_PROMPT,
    user: buildUserPrompt(fixture),
    maxTokens: 2048,
  });
  return { answer, model };
}

async function completeCouncil(fixture: GoldenFixture): Promise<{
  answer: string;
  model: string;
}> {
  const { conveneCouncil } = await import("../../backend/src/lib/llm/council.ts");
  const result = await conveneCouncil({
    question: fixture.question,
    context: fixture.context || null,
  });
  return { answer: result.finalAnswer, model: "council" };
}

async function runLive(
  fixtures: GoldenFixture[],
  council: boolean,
): Promise<{ scores: FixtureScore[]; model: string }> {
  const complete = council ? completeCouncil : completeMain;
  const scores: FixtureScore[] = [];
  let model = council ? "council" : "unknown";

  for (const fixture of fixtures) {
    const started = Date.now();
    process.stdout.write(`  ${fixture.id} ... `);
    try {
      const result = await complete(fixture);
      model = result.model;
      const score = scoreAnswer(fixture, result.answer);
      score.latencyMs = Date.now() - started;
      score.model = result.model;
      scores.push(score);
      console.log(score.passed ? "PASS" : "FAIL");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scores.push({
        id: fixture.id,
        category: fixture.category,
        passed: false,
        mentionHits: fixture.must_mention.map((term) => ({ term, found: false })),
        forbiddenHits: fixture.must_not_claim.map((term) => ({ term, found: false })),
        answerChars: 0,
        latencyMs: Date.now() - started,
        error: message.slice(0, 400),
      });
      console.log(`ERROR (${message.slice(0, 120)})`);
    }
  }

  return { scores, model };
}

async function main(): Promise<void> {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error(CLI_HELP);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    process.stdout.write(CLI_HELP);
    return;
  }

  loadEnvFiles();

  const all = loadFixtures(fixturesDir(GOLDEN_DIR));
  const fixtures = filterFixtures(all, { ids: opts.ids, limit: opts.limit });

  console.log(`Loaded ${all.length} fixtures; selected ${fixtures.length}.`);
  for (const line of summarizePlan(fixtures)) console.log(`- ${line}`);

  if (opts.dryRun) {
    const report: EvalReport = {
      mode: "dry-run",
      generatedAt: new Date().toISOString(),
      fixtures,
      passCount: 0,
      total: fixtures.length,
      notes: [
        "Dry-run only: fixtures parsed and validated. No model was called.",
        ...summarizePlan(fixtures),
        "Fixture files live in evals/golden/fixtures/.",
      ],
    };
    const markdown = formatReport(report);
    const dest = writeReportFile("sample-dry-run.md", markdown);
    console.log(`Wrote ${dest}`);
    return;
  }

  if (!canRunLive()) {
    console.error(
      "Live mode needs ANTHROPIC_API_KEY and/or LLM_MODEL. " +
        "Use --dry-run to validate fixtures without paid APIs.",
    );
    process.exitCode = 2;
    return;
  }

  if (opts.council) {
    console.warn(
      "WARNING: --council convenes the full 5-seat council + judge per fixture. " +
        "This is several paid calls each and is not for CI.",
    );
  } else {
    console.log("Live mode: main-model completeText (not the 5-seat council).");
  }

  const { scores, model } = await runLive(fixtures, opts.council);
  const passCount = scores.filter((s) => s.passed).length;
  const report: EvalReport = {
    mode: opts.council ? "council" : "live",
    generatedAt: new Date().toISOString(),
    model,
    fixtures,
    scores,
    passCount,
    total: fixtures.length,
    notes: [
      opts.council
        ? "Council mode: each fixture used conveneCouncil (5 seats + judge)."
        : "Live mode: each fixture used completeText on the active main model.",
      "Scores are keyword/rubric pass rate, not LLM-as-judge.",
    ],
  };
  const markdown = formatReport(report);
  const dest = writeReportFile(
    `${opts.council ? "council" : "live"}-${stamp()}.md`,
    markdown,
  );
  console.log(`Pass rate: ${passCount}/${fixtures.length}`);
  console.log(`Wrote ${dest}`);
  if (passCount < fixtures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
