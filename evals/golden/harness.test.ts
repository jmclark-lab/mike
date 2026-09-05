import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canRunLive,
  containsAffirmativeClaim,
  filterFixtures,
  fixturesDir,
  formatReport,
  goldenDirFromMeta,
  loadFixtures,
  parseCliArgs,
  parseFrontmatter,
  scoreAnswer,
  validateFixture,
  type GoldenFixture,
} from "./harness.ts";

function sampleFixture(overrides: Partial<GoldenFixture> = {}): GoldenFixture {
  return {
    id: "contract-demo-01",
    category: "contract",
    question: "What is the main indemnification risk in this synthetic CTA excerpt?",
    rubric: "Flag the uncapped indemnity.",
    must_mention: ["indemnif", "cap"],
    must_not_claim: ["this is legal advice"],
    context: "Synthetic CTA between Andes Clinical Partners S.A.S. and Sierra Norte Therapeutics B.V.",
    sourcePath: "memory",
    ...overrides,
  };
}

test("loads 30 unique contract/regulatory fixtures without PHI markers", () => {
  const fixtures = loadFixtures(fixturesDir(goldenDirFromMeta()));
  assert.equal(fixtures.length, 30);
  const ids = new Set(fixtures.map((f) => f.id));
  assert.equal(ids.size, 30);
  const contract = fixtures.filter((f) => f.category === "contract").length;
  const regulatory = fixtures.filter((f) => f.category === "regulatory").length;
  assert.equal(contract, 15);
  assert.equal(regulatory, 15);
  for (const fixture of fixtures) {
    assert.ok(fixture.must_mention.length >= 1, fixture.id);
    assert.ok(fixture.must_not_claim.length >= 1, fixture.id);
    assert.ok(fixture.question.length >= 20, fixture.id);
    assert.ok(fixture.context.length >= 40, fixture.id);
    assert.equal(validateFixture(fixture).length, 0, fixture.id);
  }
});

test("frontmatter parser reads folded questions and string lists", () => {
  const { data, body } = parseFrontmatter(`---
id: contract-demo-01
category: contract
question: >
  Line one of the question
  continues here.
must_mention:
  - indemnif
  - cap
must_not_claim:
  - this is legal advice
rubric: Flag the uncapped indemnity.
---

Synthetic body text for the scenario.
`);
  assert.equal(data.id, "contract-demo-01");
  assert.equal(data.category, "contract");
  assert.match(String(data.question), /Line one of the question continues here/);
  assert.deepEqual(data.must_mention, ["indemnif", "cap"]);
  assert.deepEqual(data.must_not_claim, ["this is legal advice"]);
  assert.match(body, /Synthetic body text/);
});

test("scoreAnswer passes only when mentions hit and forbidden terms do not", () => {
  const fixture = sampleFixture();
  const pass = scoreAnswer(
    fixture,
    "The indemnification is uncapped; negotiate a fees-based cap. This is analysis, not a court ruling.",
  );
  assert.equal(pass.passed, true);

  const miss = scoreAnswer(fixture, "The clause looks aggressive; ask for a cap.");
  assert.equal(miss.passed, false);
  assert.equal(miss.mentionHits.find((h) => h.term === "indemnif")?.found, false);

  const forbidden = scoreAnswer(
    fixture,
    "The indemnification needs a cap. This is legal advice you should follow.",
  );
  assert.equal(forbidden.passed, false);
  assert.equal(forbidden.forbiddenHits[0]?.found, true);

  const negated = scoreAnswer(
    fixture,
    "The indemnification is uncapped; negotiate a cap. This is not legal advice.",
  );
  assert.equal(negated.passed, true);
  assert.equal(containsAffirmativeClaim("file this study with the FDA next week", "file this study with the FDA"), true);
  assert.equal(
    containsAffirmativeClaim("Do not file this study with the FDA; it is a LATAM trial", "file this study with the FDA"),
    false,
  );
});

test("filterFixtures supports --id and --limit", () => {
  const fixtures = loadFixtures(fixturesDir(goldenDirFromMeta()));
  const one = filterFixtures(fixtures, { ids: ["contract-cta-indemnity-01"] });
  assert.equal(one.length, 1);
  assert.equal(one[0].id, "contract-cta-indemnity-01");
  const limited = filterFixtures(fixtures, { limit: 4 });
  assert.equal(limited.length, 4);
  assert.throws(() => filterFixtures(fixtures, { ids: ["does-not-exist"] }), /unknown fixture/);
});

test("parseCliArgs and canRunLive keep live mode opt-in", () => {
  const dry = parseCliArgs(["--dry-run", "--limit", "2"]);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.council, false);
  assert.equal(dry.limit, 2);
  const council = parseCliArgs(["--council", "--id=contract-cta-indemnity-01"]);
  assert.equal(council.council, true);
  assert.deepEqual(council.ids, ["contract-cta-indemnity-01"]);
  assert.throws(() => parseCliArgs(["--unknown"]), /unknown argument/);
  assert.equal(canRunLive({}), false);
  assert.equal(canRunLive({ ANTHROPIC_API_KEY: "sk-test" }), true);
  assert.equal(canRunLive({ LLM_MODEL: "claude-fable-5-1" }), true);
});

test("validateFixture rejects PHI-looking copy", () => {
  const errors = validateFixture(
    sampleFixture({
      context: "Patient 12345 date of birth 1980-01-01 presented with fever.",
    }),
  );
  assert.ok(errors.some((e) => /PHI/i.test(e)));
});

test("loadFixtures fails closed on a bad file", () => {
  const dir = mkdtempSync(join(tmpdir(), "golden-eval-"));
  writeFileSync(join(dir, "bad.md"), "no frontmatter here\n", "utf8");
  assert.throws(() => loadFixtures(dir), /frontmatter/);
});

test("formatReport dry-run does not invent a pass rate", () => {
  const fixtures = [sampleFixture()];
  const markdown = formatReport({
    mode: "dry-run",
    generatedAt: "2026-09-05T13:00:00.000Z",
    fixtures,
    passCount: 0,
    total: 1,
    notes: ["offline"],
  });
  assert.match(markdown, /n\/a \(dry-run/);
  assert.match(markdown, /contract-demo-01/);
  assert.doesNotMatch(markdown, /PASS rate: 0\/1/);
});
