import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_MAIN_MODELS,
  DEFAULT_MAIN_MODEL,
  resolveModel,
} from "../models";

test("CLAUDE_MAIN_MODELS lists Fable 5.1 first and keeps Fable 5 selectable", () => {
  assert.equal(CLAUDE_MAIN_MODELS[0], "claude-fable-5-1");
  assert.equal(CLAUDE_MAIN_MODELS.includes("claude-fable-5"), true);
  assert.equal(
    resolveModel("claude-fable-5-1", DEFAULT_MAIN_MODEL),
    "claude-fable-5-1",
  );
  assert.equal(DEFAULT_MAIN_MODEL, "gemini-3-flash-preview");
});

test("CLAUDE_MAIN_MODELS lists Opus 5 above Opus 4.8", () => {
  const opus5 = CLAUDE_MAIN_MODELS.indexOf("claude-opus-5");
  const opus48 = CLAUDE_MAIN_MODELS.indexOf("claude-opus-4-8");
  assert.ok(opus5 >= 0);
  assert.ok(opus48 > opus5);
  assert.equal(resolveModel("claude-opus-5", DEFAULT_MAIN_MODEL), "claude-opus-5");
  assert.equal(DEFAULT_MAIN_MODEL, "gemini-3-flash-preview");
});
