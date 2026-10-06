import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_MAIN_MODELS,
  DEFAULT_MAIN_MODEL,
  DEFAULT_TITLE_MODEL,
  GEMINI_LOW_MODELS,
  resolveModel,
} from "../models";

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
