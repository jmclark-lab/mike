import assert from "node:assert/strict";
import test from "node:test";
import {
  claudeChatTurnFailure,
  DEFAULT_CLAUDE_CHAT_MAX_TOKENS,
  resolveClaudeChatMaxTokens,
} from "../llm/claude";

test("chat orchestrator token budget defaults to 32000 (thinking + tool_use)", () => {
  assert.equal(resolveClaudeChatMaxTokens({}), DEFAULT_CLAUDE_CHAT_MAX_TOKENS);
  assert.equal(DEFAULT_CLAUDE_CHAT_MAX_TOKENS, 32000);
  assert.equal(
    resolveClaudeChatMaxTokens({ CLAUDE_CHAT_MAX_TOKENS: "48000" }),
    48000,
  );
});

test("max_tokens with no tool_use fails the chat tool loop instead of returning a preamble", () => {
  const message = claudeChatTurnFailure("max_tokens", 0, 32000);
  assert.match(message ?? "", /stop_reason=max_tokens/);
  assert.match(message ?? "", /no tool_use/);
  assert.equal(claudeChatTurnFailure("end_turn", 0, 32000), null);
  assert.equal(claudeChatTurnFailure("tool_use", 1, 32000), null);
  assert.equal(claudeChatTurnFailure("max_tokens", 1, 32000), null);
});
