import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_LOW_MODELS,
  CLAUDE_MAIN_MODELS,
  CLAUDE_MID_MODELS,
  DEFAULT_MAIN_MODEL,
  DEFAULT_TITLE_MODEL,
  GEMINI_LOW_MODELS,
  GEMINI_MAIN_MODELS,
  OPENAI_MAIN_MODELS,
  resolveModel,
} from "../models";
import { COUNCIL_JUDGE, COUNCIL_MEMBERS } from "../council";
import { tokenPriceForModel } from "../pricing";

test("CLAUDE_MAIN_MODELS lists Fable 5.1 first and keeps Fable 5 selectable", () => {
  assert.equal(CLAUDE_MAIN_MODELS[0], "claude-fable-5-1");
  assert.equal(CLAUDE_MAIN_MODELS.includes("claude-fable-5"), true);
  assert.equal(
    resolveModel("claude-fable-5-1", DEFAULT_MAIN_MODEL),
    "claude-fable-5-1",
  );
  assert.equal(DEFAULT_MAIN_MODEL, "claude-fable-5-1");
});

test("CLAUDE_MAIN_MODELS lists Opus 5.5 above Opus 5 and Opus 4.8", () => {
  const opus55 = CLAUDE_MAIN_MODELS.indexOf("claude-opus-5-5");
  const opus5 = CLAUDE_MAIN_MODELS.indexOf("claude-opus-5");
  const opus48 = CLAUDE_MAIN_MODELS.indexOf("claude-opus-4-8");
  assert.ok(opus55 >= 0);
  assert.ok(opus5 > opus55);
  assert.ok(opus48 > opus5);
  assert.equal(
    resolveModel("claude-opus-5-5", DEFAULT_MAIN_MODEL),
    "claude-opus-5-5",
  );
  assert.equal(resolveModel("claude-opus-5", DEFAULT_MAIN_MODEL), "claude-opus-5");
  assert.equal(DEFAULT_MAIN_MODEL, "claude-fable-5-1");
});

test("title/low tier uses stable gemini-3.1-flash-lite; retired preview id falls back", () => {
  assert.equal(DEFAULT_TITLE_MODEL, "gemini-3.1-flash-lite");
  assert.deepEqual([...GEMINI_LOW_MODELS], ["gemini-3.1-flash-lite"]);
  assert.equal(
    resolveModel("gemini-3.1-flash-lite", DEFAULT_TITLE_MODEL),
    "gemini-3.1-flash-lite",
  );
  // Saved preferences that still hold the shut-down preview id resolve to the default.
  assert.equal(
    resolveModel("gemini-3.1-flash-lite-preview", DEFAULT_TITLE_MODEL),
    "gemini-3.1-flash-lite",
  );
});

test("frontier refresh adds verified selectable ids and moves Claude tiers", () => {
  assert.equal(GEMINI_MAIN_MODELS[0], "gemini-4-argon");
  assert.equal(
    resolveModel("gemini-4-argon", DEFAULT_MAIN_MODEL),
    "gemini-4-argon",
  );

  assert.equal(OPENAI_MAIN_MODELS[0], "gpt-6-astra");
  assert.equal(OPENAI_MAIN_MODELS.includes("gpt-6.1-sol"), true);
  assert.equal(OPENAI_MAIN_MODELS.includes("gpt-6-sol"), true);
  assert.ok(
    OPENAI_MAIN_MODELS.indexOf("gpt-6.1-sol") <
      OPENAI_MAIN_MODELS.indexOf("gpt-6-sol"),
  );
  assert.equal(resolveModel("gpt-6.1-sol", DEFAULT_MAIN_MODEL), "gpt-6.1-sol");
  assert.equal(resolveModel("gpt-6-sol", DEFAULT_MAIN_MODEL), "gpt-6-sol");

  assert.equal(CLAUDE_MAIN_MODELS.includes("claude-sonnet-5-5"), true);
  assert.ok(
    CLAUDE_MAIN_MODELS.indexOf("claude-sonnet-5-5") <
      CLAUDE_MAIN_MODELS.indexOf("claude-sonnet-4-6"),
  );
  assert.deepEqual([...CLAUDE_MID_MODELS], ["claude-sonnet-5-5"]);
  assert.deepEqual([...CLAUDE_LOW_MODELS], ["claude-haiku-5-5"]);
  assert.equal(
    resolveModel("claude-haiku-5-5", DEFAULT_TITLE_MODEL),
    "claude-haiku-5-5",
  );
  assert.equal(
    resolveModel("claude-haiku-4-5", DEFAULT_TITLE_MODEL),
    "claude-haiku-4-5",
  );

  assert.equal(CLAUDE_MAIN_MODELS[0], "claude-fable-5-1");
  assert.equal(DEFAULT_MAIN_MODEL, "claude-fable-5-1");
  assert.deepEqual(COUNCIL_MEMBERS, [
    "claude-fable-5-1",
    "gpt-6-astra",
    "gemini-4-argon",
    "grok-4.7",
  ]);
  assert.equal(COUNCIL_JUDGE, "claude-opus-5-5");
});

test("gemini-4-argon price is $2/$10 through Nov 30 and $4/$20 from Dec 1", () => {
  const intro = tokenPriceForModel(
    "gemini-4-argon",
    new Date("2026-11-01T00:00:00.000Z"),
  );
  const standard = tokenPriceForModel(
    "gemini-4-argon",
    new Date("2026-12-01T00:00:00.000Z"),
  );
  assert.equal(intro?.inputUsdPerMillion, 2);
  assert.equal(intro?.outputUsdPerMillion, 10);
  assert.equal(standard?.inputUsdPerMillion, 4);
  assert.equal(standard?.outputUsdPerMillion, 20);
  assert.equal(
    tokenPriceForModel("gpt-6.1-sol")?.inputUsdPerMillion,
    2,
  );
  assert.equal(
    tokenPriceForModel("claude-sonnet-5-5")?.outputUsdPerMillion,
    10,
  );
  assert.equal(
    tokenPriceForModel("claude-haiku-5-5")?.inputUsdPerMillion,
    0.1,
  );
});
