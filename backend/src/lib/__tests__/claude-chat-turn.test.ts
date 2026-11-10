import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_LONG_DOCUMENT_CONTINUATION,
  claudeChatTurnFailure,
  DEFAULT_CLAUDE_CHAT_MAX_TOKENS,
  FABLE_MAX_OUTPUT_TOKENS,
  isLongClaudeDocument,
  LONG_DOCUMENT_CHARS,
  LONG_DOCUMENT_TURN_INSTRUCTION,
  resolveClaudeChatMaxTokens,
  shouldContinueLongDocumentTurn,
  streamClaude,
  type ClaudeMessageStream,
} from "../llm/claude";

test("chat orchestrator token budget defaults to 32000 (thinking + tool_use)", () => {
  assert.equal(resolveClaudeChatMaxTokens({}), DEFAULT_CLAUDE_CHAT_MAX_TOKENS);
  assert.equal(DEFAULT_CLAUDE_CHAT_MAX_TOKENS, 32000);
  assert.equal(
    resolveClaudeChatMaxTokens({ CLAUDE_CHAT_MAX_TOKENS: "48000" }),
    48000,
  );
  assert.equal(
    resolveClaudeChatMaxTokens({ CLAUDE_CHAT_MAX_TOKENS: "200000" }),
    FABLE_MAX_OUTPUT_TOKENS,
  );
  assert.equal(FABLE_MAX_OUTPUT_TOKENS, 128000);
  // A stale CLAUDE_CHAT_MAX_TOKENS=32000 must not re-cap a long review.
  assert.equal(
    resolveClaudeChatMaxTokens(
      { CLAUDE_CHAT_MAX_TOKENS: "32000" },
      { longDocument: true },
    ),
    FABLE_MAX_OUTPUT_TOKENS,
  );
});

test("long-document detection uses the latest user text, not tool results", () => {
  const contract = "x".repeat(LONG_DOCUMENT_CHARS);
  assert.equal(
    isLongClaudeDocument([{ role: "user", content: contract }]),
    true,
  );
  assert.equal(
    isLongClaudeDocument([
      { role: "user", content: "x".repeat(LONG_DOCUMENT_CHARS - 1) },
    ]),
    false,
  );
  assert.equal(
    isLongClaudeDocument([
      { role: "user", content: contract },
      { role: "assistant", content: "partial" },
      { role: "user", content: [{ type: "tool_result" }] },
    ]),
    true,
  );
  assert.equal(
    isLongClaudeDocument([
      { role: "user", content: contract },
      { role: "user", content: "What about section 4?" },
    ]),
    false,
  );
  assert.equal(
    shouldContinueLongDocumentTurn({
      longDocument: true,
      stopReason: "max_tokens",
      toolCallCount: 0,
      continuationsUsed: 0,
      assistantBlockCount: 2,
    }),
    true,
  );
  assert.equal(
    shouldContinueLongDocumentTurn({
      longDocument: false,
      stopReason: "max_tokens",
      toolCallCount: 0,
      continuationsUsed: 0,
      assistantBlockCount: 2,
    }),
    false,
  );
  assert.equal(
    shouldContinueLongDocumentTurn({
      longDocument: true,
      stopReason: "max_tokens",
      toolCallCount: 1,
      continuationsUsed: 0,
      assistantBlockCount: 2,
    }),
    false,
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

type ScriptedTurn = {
  stop_reason: string;
  content: Array<Record<string, unknown>>;
};

function scriptedClaudeStream(turns: ScriptedTurn[]) {
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const stream = (body: Record<string, unknown>): ClaudeMessageStream => {
    bodies.push(body);
    const turn = turns[Math.min(call, turns.length - 1)];
    call += 1;
    const handlers = new Map<string, (payload: unknown) => void>();
    return {
      on(event: string, handler: (payload: never) => void) {
        handlers.set(event, handler as (payload: unknown) => void);
      },
      abort() {},
      async finalMessage() {
        for (const block of turn.content) {
          if (block.type === "text" && typeof block.text === "string") {
            handlers.get("text")?.(block.text);
          }
          if (block.type === "thinking" && typeof block.thinking === "string") {
            handlers.get("thinking")?.(block.thinking);
          }
        }
        return {
          stop_reason: turn.stop_reason,
          content: turn.content,
        };
      },
    } as ClaudeMessageStream;
  };
  return { stream, bodies, calls: () => call };
}

function longContract(): string {
  return (
    "Review this clinical trial agreement.\n\n" +
    "CLINICAL TRIAL AGREEMENT\n" +
    "Section. The sponsor shall pay within thirty days. ".repeat(800)
  );
}

test("a long document that stops at max_tokens continues to a final answer", async () => {
  const contract = longContract();
  assert.ok(contract.length >= LONG_DOCUMENT_CHARS);
  const thinking = {
    type: "thinking",
    thinking: "Payment, indemnification, and publication need a full review.",
    signature: "sig-long-cta",
  };
  const script = scriptedClaudeStream([
    {
      stop_reason: "max_tokens",
      content: [
        thinking,
        {
          type: "text",
          text: "I'll review this clinical trial agreement section by section. Payment is monthly.",
        },
      ],
    },
    {
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "FINAL OPINION: The sponsor may terminate for convenience on 30 days' notice. Add a cure period before termination for cause.",
        },
      ],
    },
  ]);
  const result = await streamClaude(
      {
        model: "claude-fable-5-2",
        systemPrompt: "You are Mike.",
        messages: [{ role: "user", content: contract }],
        enableThinking: true,
        tools: [
          {
            type: "function",
            function: {
              name: "read_document",
              description: "Read a document",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      { stream: script.stream, env: { CLAUDE_CHAT_MAX_TOKENS: "32000" } },
    );
    assert.match(result.fullText, /FINAL OPINION:/);
    assert.match(result.fullText, /cure period/);
    assert.match(result.fullText, /Payment is monthly/);
    assert.equal(script.calls(), 2);
    assert.equal(script.bodies[0].max_tokens, FABLE_MAX_OUTPUT_TOKENS);
    assert.equal(script.bodies[1].max_tokens, FABLE_MAX_OUTPUT_TOKENS);
    assert.equal(script.bodies[0].system, script.bodies[1].system);
    assert.match(String(script.bodies[0].system), /LONG DOCUMENT:/);
    assert.match(
      String(script.bodies[0].system),
      new RegExp(LONG_DOCUMENT_TURN_INSTRUCTION.split("\n")[0]),
    );
    assert.deepEqual(script.bodies[0].thinking, { type: "adaptive" });
    assert.deepEqual(script.bodies[1].thinking, { type: "adaptive" });
    assert.equal(
      (script.bodies[0].output_config as { effort?: string }).effort,
      "high",
    );
    assert.equal(Object.hasOwn(script.bodies[0], "budget_tokens"), false);
    const followup = script.bodies[1].messages as Array<{
      role: string;
      content: unknown;
    }>;
    assert.equal(followup[1]?.role, "assistant");
    assert.deepEqual(followup[1]?.content, [
      thinking,
      {
        type: "text",
        text: "I'll review this clinical trial agreement section by section. Payment is monthly.",
      },
    ]);
    assert.equal(followup[2]?.role, "user");
    assert.equal(followup[2]?.content, CLAUDE_LONG_DOCUMENT_CONTINUATION);
    assert.deepEqual(script.bodies[0].tools, script.bodies[1].tools);
});

test("a short ask that stops at max_tokens still fails without a second call", async () => {
  const script = scriptedClaudeStream([
    {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "I'll look that up and then answer." }],
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "This second turn must not run." }],
    },
  ]);
  await assert.rejects(
    streamClaude(
      {
        model: "claude-fable-5-2",
        systemPrompt: "You are Mike.",
        messages: [{ role: "user", content: "What is consideration?" }],
        enableThinking: true,
      },
      { stream: script.stream, env: {} },
    ),
    /stop_reason=max_tokens and no tool_use \(max_tokens=32000\)/,
  );
  assert.equal(script.calls(), 1);
  assert.equal(script.bodies[0].max_tokens, DEFAULT_CLAUDE_CHAT_MAX_TOKENS);
  assert.equal(String(script.bodies[0].system).includes("LONG DOCUMENT:"), false);
});

test("a short ask that finishes still uses one 32k streamed turn", async () => {
  const script = scriptedClaudeStream([
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Consideration is the bargained-for exchange." }],
    },
  ]);
  const result = await streamClaude(
    {
      model: "claude-fable-5-2",
      systemPrompt: "You are Mike.",
      messages: [{ role: "user", content: "What is consideration?" }],
      enableThinking: true,
    },
    { stream: script.stream, env: {} },
  );
  assert.equal(result.fullText, "Consideration is the bargained-for exchange.");
  assert.equal(script.calls(), 1);
  assert.equal(script.bodies[0].max_tokens, 32000);
});

test("a long document still fails once bounded continuations stay at max_tokens", async () => {
  const script = scriptedClaudeStream([
    {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "I'll start the review. " }],
    },
    {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "Still outlining. " }],
    },
    {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "Not finished. " }],
    },
  ]);
  await assert.rejects(
    streamClaude(
      {
        model: "claude-fable-5-2",
        systemPrompt: "You are Mike.",
        messages: [{ role: "user", content: longContract() }],
        enableThinking: true,
      },
      { stream: script.stream },
    ),
    /The intake preamble is not a final answer/,
  );
  assert.equal(script.calls(), 3);
});

test("a long document max_tokens stop that already called a tool still runs the tool", async () => {
  const script = scriptedClaudeStream([
    {
      stop_reason: "max_tokens",
      content: [
        {
          type: "tool_use",
          id: "toolu_read",
          name: "read_document",
          input: { doc_id: "doc-0" },
        },
      ],
    },
    {
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "FINAL OPINION: Section 8 indemnification is uncapped and should be mutual.",
        },
      ],
    },
  ]);
  let toolRuns = 0;
  const result = await streamClaude(
    {
      model: "claude-fable-5-2",
      systemPrompt: "You are Mike.",
      messages: [{ role: "user", content: longContract() }],
      enableThinking: true,
      runTools: async (calls) => {
        toolRuns += 1;
        assert.equal(calls[0]?.name, "read_document");
        return [{ tool_use_id: calls[0].id, content: "Section 8 is uncapped." }];
      },
    },
    { stream: script.stream },
  );
  assert.equal(toolRuns, 1);
  assert.match(result.fullText, /FINAL OPINION:/);
  const followup = script.bodies[1].messages as Array<{
    role: string;
    content: unknown;
  }>;
  assert.equal(
    followup.some((message) => message.content === CLAUDE_LONG_DOCUMENT_CONTINUATION),
    false,
  );
  const toolTurn = followup.find((message) => message.role === "user" && Array.isArray(message.content));
  assert.equal(
    (toolTurn?.content as Array<{ type?: string }>)[0]?.type,
    "tool_result",
  );
});

test("a short ask whose tool result is the contract continues after max_tokens", async () => {
  const contract = longContract();
  const script = scriptedClaudeStream([
    {
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_read",
          name: "read_document",
          input: { doc_id: "doc-0" },
        },
      ],
    },
    {
      stop_reason: "max_tokens",
      content: [
        {
          type: "thinking",
          thinking: "The agreement's indemnity clause is uncapped.",
          signature: "sig-tool-result",
        },
        { type: "text", text: "I'll review the attached clinical trial agreement." },
      ],
    },
    {
      stop_reason: "end_turn",
      content: [
        {
          type: "text",
          text: "FINAL OPINION: Indemnity in Section 8 is uncapped and should be mutual.",
        },
      ],
    },
  ]);
  const result = await streamClaude(
    {
      model: "claude-fable-5-2",
      systemPrompt: "You are Mike.",
      messages: [{ role: "user", content: "Please review the attached agreement." }],
      enableThinking: true,
      runTools: async (calls) => [
        { tool_use_id: calls[0].id, content: contract },
      ],
    },
    { stream: script.stream, env: { CLAUDE_CHAT_MAX_TOKENS: "32000" } },
  );
  assert.match(result.fullText, /FINAL OPINION:/);
  assert.equal(script.calls(), 3);
  assert.equal(script.bodies[0].max_tokens, 32000);
  assert.equal(script.bodies[1].max_tokens, FABLE_MAX_OUTPUT_TOKENS);
  assert.equal(script.bodies[2].max_tokens, FABLE_MAX_OUTPUT_TOKENS);
  assert.equal(script.bodies[0].system, script.bodies[2].system);
  assert.equal(String(script.bodies[0].system).includes("LONG DOCUMENT:"), false);
  const continued = script.bodies[2].messages as Array<{
    role: string;
    content: unknown;
  }>;
  const replay = continued.find(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      (message.content as Array<{ type?: string }>).some(
        (block) => block.type === "thinking",
      ),
  );
  assert.equal(
    (replay?.content as Array<{ signature?: string }>)[0]?.signature,
    "sig-tool-result",
  );
});
