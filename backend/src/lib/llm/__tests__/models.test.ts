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
