import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAnswerSource,
  extractCouncilQuestion,
  isCouncilSynthesis,
  looksLikeCouncilPreamble,
  parseMinQuorumFromPrompt,
  preferCouncilSynthesis,
  promptRequestsCouncil,
  resolveCouncilContext,
  utf8ByteLength,
} from "../councilCompletion";

const PREAMBLE =
  "I'll convene the five-seat Council on the full v6.6 text plus the v6.5→v6.6 change log so all seats reason over identical evidence. I'm setting quorum at 3 so a Fable seat failure does not suppress the judge synthesis; the actual roster will be reported regardless.";

const SYNTHESIS =
  "[Council: 4/5 opinions received (Fugu Ultra, GPT-6 Astra, Gemini 3.1 Pro Preview, Grok 4.6); failed: Fable 5.1; reconciled by Opus 5]\n\nThe PTA amendment is approvable with conditions.";

const QUORUM_FAIL =
  "Council deliberation failed and no council opinion was produced — Council quorum incomplete: 2/3 required opinions received after retries. Missing: Fable 5.1: empty response.";

test("promptRequestsCouncil matches operational council language, not generic 'council' in a statute", () => {
  assert.equal(
    promptRequestsCouncil(
      "Convene the five-seat Council on the Argentine PTA v6.6. min_quorum 3.",
    ),
    true,
  );
  assert.equal(promptRequestsCouncil("Please convene_council on this NDA."), true);
  assert.equal(promptRequestsCouncil("Run the legal council on this MSA."), true);
  assert.equal(
    promptRequestsCouncil(
      "The municipal council shall meet on Tuesdays. Review clause 4.",
    ),
    false,
  );
});

test("preamble is detected and is never classified as synthesis", () => {
  assert.equal(looksLikeCouncilPreamble(PREAMBLE), true);
  assert.equal(isCouncilSynthesis(PREAMBLE), false);
  assert.equal(classifyAnswerSource(PREAMBLE), "preamble");
});

test("synthesis and quorum-failure dumps are terminal council answers", () => {
  assert.equal(isCouncilSynthesis(SYNTHESIS), true);
  assert.equal(looksLikeCouncilPreamble(SYNTHESIS), false);
  assert.equal(classifyAnswerSource(SYNTHESIS), "synthesis");
  assert.equal(classifyAnswerSource(QUORUM_FAIL), "quorum_failure");
});

test("preferCouncilSynthesis drops a leading intake preamble", () => {
  const mixed = `${PREAMBLE}\n\n${SYNTHESIS}`;
  assert.equal(preferCouncilSynthesis(mixed), SYNTHESIS);
  assert.equal(preferCouncilSynthesis(PREAMBLE), PREAMBLE);
});

test("parseMinQuorumFromPrompt reads min_quorum 3 and quorum at 3", () => {
  assert.equal(parseMinQuorumFromPrompt("min_quorum 3 so Fable can fail"), 3);
  assert.equal(parseMinQuorumFromPrompt("min_quorum: 4"), 4);
  assert.equal(parseMinQuorumFromPrompt("I'm setting quorum at 3"), 3);
  assert.equal(parseMinQuorumFromPrompt("no quorum mentioned"), undefined);
});

test("resolveCouncilContext prefers the user evidence pack when the tool context is truncated", () => {
  const evidence = "E".repeat(8000);
  assert.equal(resolveCouncilContext("", evidence), evidence);
  assert.equal(resolveCouncilContext("short", evidence), evidence);
  const fullCopy = evidence + " extra";
  assert.equal(resolveCouncilContext(fullCopy, evidence), fullCopy);
});

test("extractCouncilQuestion keeps short prompts intact", () => {
  assert.equal(extractCouncilQuestion("Review clause 9."), "Review clause 9.");
  assert.equal(extractCouncilQuestion("Q".repeat(5000)).length, 4000);
});

test("utf8ByteLength counts multibyte council text", () => {
  assert.equal(utf8ByteLength("á"), 2);
  assert.ok(utf8ByteLength(PREAMBLE) > PREAMBLE.length / 2);
});
