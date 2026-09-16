import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNCIL_JUDGE,
  COUNCIL_MEMBERS,
  COUNCIL_PARTIAL_ANSWER_LIMIT,
  CouncilQuorumError,
  conveneCouncilWithCompleter,
  formatCouncilQuorumFailure,
  resolveCouncilJudge,
  resolveCouncilMinQuorum,
  resolveCouncilSeats,
} from "../council";

const noDelay = {
  retryBaseDelayMs: 0,
  sleepFn: async () => undefined,
};

test("default council seats are five providers including Fable 5.1 and Grok 4.6", () => {
  const seats = resolveCouncilSeats({});
  assert.equal(seats.length, 5);
  assert.equal(seats[0].model, "claude-fable-5-1");
  assert.equal(seats[0].label, "Fable 5.1");
  assert.equal(seats[4].provider, "xai");
  assert.equal(seats[4].model, "grok-4.6");
  assert.equal(seats[4].label, "Grok 4.6");
  assert.equal(seats[0].maxTokens, 32000);
  assert.equal(seats[1].maxTokens, 16000);
  assert.equal(seats[4].maxTokens, 8000);
  assert.equal(COUNCIL_MEMBERS.length, 5);
  assert.deepEqual(COUNCIL_MEMBERS, [
    "claude-fable-5-1",
    "fugu-ultra-20260615",
    "gpt-6-astra",
    "gemini-3.1-pro-preview",
    "grok-4.6",
  ]);
});

test("the council invokes all five declared members before the judge", async () => {
  const invoked: string[] = [];
  const result = await conveneCouncilWithCompleter(
    {
      question: "What is the safer contractual position?",
      context: "Agreed facts.",
    },
    async ({ model }) => {
      invoked.push(model);
      return model === COUNCIL_JUDGE
        ? "Reconciled answer"
        : `Independent answer from ${model}`;
    },
    noDelay,
  );

  assert.deepEqual(
    invoked.slice(0, COUNCIL_MEMBERS.length).sort(),
    [...COUNCIL_MEMBERS].sort(),
  );
  assert.equal(invoked.at(-1), COUNCIL_JUDGE);
  assert.equal(invoked.length, COUNCIL_MEMBERS.length + 1);
  assert.equal(result.respondedCount, 5);
  assert.match(result.finalAnswer, /mandatory 5\/5 opinions received/);
  assert.match(result.finalAnswer, /Reconciled answer/);
});

test("a transient member failure is retried using the same model", async () => {
  const transient = COUNCIL_MEMBERS[1];
  const attempts = new Map<string, number>();
  const result = await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model }) => {
      attempts.set(model, (attempts.get(model) ?? 0) + 1);
      if (model === transient && attempts.get(model)! < 3) {
        throw new Error("provider temporarily unavailable");
      }
      return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
    },
    { ...noDelay, maxAttempts: 3 },
  );

  assert.equal(attempts.get(transient), 3);
  assert.equal(
    result.members.find((member) => member.model === transient)?.attempts,
    3,
  );
  assert.equal(result.respondedCount, 5);
  assert.equal(attempts.get(COUNCIL_JUDGE), 1);
});

test("an incomplete quorum throws and never invokes the judge", async () => {
  const failed = COUNCIL_MEMBERS[2];
  const invoked: string[] = [];

  await assert.rejects(
    () =>
      conveneCouncilWithCompleter(
        { question: "Review this matter." },
        async ({ model }) => {
          invoked.push(model);
          if (model === failed) throw new Error("provider unavailable");
          return model === COUNCIL_JUDGE
            ? "Judge answer"
            : `Answer from ${model}`;
        },
        { ...noDelay, maxAttempts: 3 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof CouncilQuorumError);
      assert.equal(error.respondedCount, 4);
      assert.equal(error.requiredCount, 5);
      assert.match(error.message, /GPT-6 Astra/);
      return true;
    },
  );

  assert.equal(invoked.filter((model) => model === failed).length, 3);
  assert.equal(invoked.includes(COUNCIL_JUDGE), false);
});

test("empty member answers are retried and cannot satisfy quorum", async () => {
  const empty = COUNCIL_MEMBERS[3];
  const invoked: string[] = [];

  await assert.rejects(
    () =>
      conveneCouncilWithCompleter(
        { question: "Review this matter." },
        async ({ model }) => {
          invoked.push(model);
          return model === empty ? "   " : `Answer from ${model}`;
        },
        { ...noDelay, maxAttempts: 2 },
      ),
    CouncilQuorumError,
  );

  assert.equal(invoked.filter((model) => model === empty).length, 2);
  assert.equal(invoked.includes(COUNCIL_JUDGE), false);
});

test("the judge is retried after, and only after, complete quorum", async () => {
  let judgeAttempts = 0;
  const result = await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model }) => {
      if (model !== COUNCIL_JUDGE) return `Answer from ${model}`;
      judgeAttempts += 1;
      if (judgeAttempts === 1) throw new Error("judge timeout");
      return "Recovered judge answer";
    },
    { ...noDelay, maxAttempts: 2 },
  );

  assert.equal(judgeAttempts, 2);
  assert.match(result.finalAnswer, /Recovered judge answer/);
});

test("council seats are configurable and the OpenAI seat always uses xhigh reasoning", async () => {
  const seats = resolveCouncilSeats({
    COUNCIL_ANTHROPIC_MODEL: "claude-required",
    COUNCIL_SAKANA_MODEL: "fugu-required",
    COUNCIL_OPENAI_MODEL: "gpt-6-astra",
    COUNCIL_OPENAI_MAX_TOKENS: "32000",
    COUNCIL_GEMINI_MODEL: "gemini-3.5-pro",
    COUNCIL_GEMINI_LABEL: "Gemini 3.5 Pro",
    COUNCIL_XAI_MODEL: "grok-required",
    COUNCIL_XAI_MAX_TOKENS: "12000",
  });

  assert.deepEqual(
    seats.map((seat) => seat.model),
    [
      "claude-required",
      "fugu-required",
      "gpt-6-astra",
      "gemini-3.5-pro",
      "grok-required",
    ],
  );
  assert.equal(seats[2].label, "GPT-6 Astra");
  assert.equal(seats[2].reasoningEffort, "xhigh");
  assert.equal(seats[0].maxTokens, 32000);
  assert.equal(seats[1].maxTokens, 16000);
  assert.equal(seats[2].maxTokens, 32000);
  assert.equal(seats[3].maxTokens, 6000);
  assert.equal(seats[3].label, "Gemini 3.5 Pro");
  assert.equal(seats[4].provider, "xai");
  assert.equal(seats[4].label, "Grok 4.6");
  assert.equal(seats[4].maxTokens, 12000);
});

test("the Anthropic and Sakana council calls receive the raised token budgets", async () => {
  const observed = new Map<string, number | undefined>();
  await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model, maxTokens }) => {
      if (model === "claude-fable-5-1" || model === "fugu-ultra-20260615") {
        observed.set(model, maxTokens);
      }
      return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
    },
    noDelay,
  );

  assert.equal(observed.get("claude-fable-5-1"), 32000);
  assert.equal(observed.get("fugu-ultra-20260615"), 16000);
});

test("the xAI council call receives the Grok 4.6 token budget", async () => {
  let observed: { maxTokens?: number } | undefined;
  await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model, maxTokens }) => {
      if (model === "grok-4.6") observed = { maxTokens };
      return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
    },
    noDelay,
  );

  assert.deepEqual(observed, { maxTokens: 8000 });
});

test("the OpenAI council call receives the Astra reasoning and token budget", async () => {
  let observed: { reasoningEffort?: string; maxTokens?: number } | undefined;
  await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model, reasoningEffort, maxTokens }) => {
      if (model === "gpt-6-astra") observed = { reasoningEffort, maxTokens };
      return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
    },
    noDelay,
  );

  assert.deepEqual(observed, { reasoningEffort: "xhigh", maxTokens: 16384 });
});

test("a four-seat configuration is rejected before any provider call", async () => {
  let calls = 0;
  const fourSeats = resolveCouncilSeats({}).slice(0, 4);

  await assert.rejects(
    () =>
      conveneCouncilWithCompleter(
        { question: "Review this matter." },
        async () => {
          calls += 1;
          return "answer";
        },
        { ...noDelay, seats: fourSeats },
      ),
    /exactly 5 seats are required, got 4/,
  );
  assert.equal(calls, 0);
});

test("the council judge defaults to Opus 5 and is env-overridable", () => {
  assert.equal(COUNCIL_JUDGE, "claude-opus-5");
  assert.equal(resolveCouncilJudge({}), "claude-opus-5");
  assert.equal(
    resolveCouncilJudge({ COUNCIL_JUDGE: "claude-opus-4-8" }),
    "claude-opus-4-8",
  );
});

test("the council judge call receives the Opus 5 token budget", async () => {
  let observed: { model?: string; maxTokens?: number } | undefined;
  const result = await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model, maxTokens }) => {
      if (model === COUNCIL_JUDGE) observed = { model, maxTokens };
      return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
    },
    noDelay,
  );

  assert.deepEqual(observed, { model: "claude-opus-5", maxTokens: 16000 });
  assert.match(result.finalAnswer, /reconciled by Opus 5/);
});

test("min_quorum=4 with one empty seat still judges the successful opinions", async () => {
  const empty = COUNCIL_MEMBERS[0];
  const invoked: string[] = [];
  let judgeUser = "";
  let judgeSystem = "";
  const result = await conveneCouncilWithCompleter(
    { question: "Review this matter.", minQuorum: 4 },
    async ({ model, user, systemPrompt }) => {
      invoked.push(model);
      if (model === empty) return "   ";
      if (model === COUNCIL_JUDGE) {
        judgeUser = user;
        judgeSystem = systemPrompt ?? "";
        return "Partial reconcile";
      }
      return `Answer from ${model}`;
    },
    { ...noDelay, maxAttempts: 2 },
  );

  assert.equal(result.respondedCount, 4);
  assert.equal(invoked.filter((model) => model === empty).length, 2);
  assert.equal(invoked.includes(COUNCIL_JUDGE), true);
  assert.match(result.finalAnswer, /4\/5 opinions received/);
  assert.match(result.finalAnswer, /failed: Fable 5\.1/);
  assert.match(result.finalAnswer, /reconciled by Opus 5/);
  assert.doesNotMatch(result.finalAnswer, /mandatory 5\/5/);
  assert.match(judgeUser, /FAILED SEATS/);
  assert.match(judgeUser, /Fable 5\.1/);
  assert.match(judgeUser, /Answer from fugu-ultra-20260615/);
  assert.doesNotMatch(judgeUser, /Answer from claude-fable-5-1/);
  assert.match(judgeSystem, /do not invent/i);
  assert.equal(
    result.members.find((member) => member.model === empty)?.ok,
    false,
  );
});

test("min_quorum=5 with one empty seat still fails and never invokes the judge", async () => {
  const empty = COUNCIL_MEMBERS[3];
  const invoked: string[] = [];

  await assert.rejects(
    () =>
      conveneCouncilWithCompleter(
        { question: "Review this matter.", minQuorum: 5 },
        async ({ model }) => {
          invoked.push(model);
          return model === empty ? "   " : `Answer from ${model}`;
        },
        { ...noDelay, maxAttempts: 2 },
      ),
    (error: unknown) => {
      assert.ok(error instanceof CouncilQuorumError);
      assert.equal(error.respondedCount, 4);
      assert.equal(error.requiredCount, 5);
      assert.match(error.message, /Gemini 3\.1 Pro Preview/);
      assert.equal(
        error.members.filter((member) => member.ok).length,
        4,
      );
      return true;
    },
  );

  assert.equal(invoked.filter((model) => model === empty).length, 2);
  assert.equal(invoked.includes(COUNCIL_JUDGE), false);
});

test("COUNCIL_MIN_QUORUM env is clamped to 1–5 and overridden by the call", () => {
  assert.equal(resolveCouncilMinQuorum(undefined, {}), 5);
  assert.equal(resolveCouncilMinQuorum(undefined, { COUNCIL_MIN_QUORUM: "4" }), 4);
  assert.equal(resolveCouncilMinQuorum(undefined, { COUNCIL_MIN_QUORUM: "0" }), 1);
  assert.equal(resolveCouncilMinQuorum(undefined, { COUNCIL_MIN_QUORUM: "9" }), 5);
  assert.equal(resolveCouncilMinQuorum(4, { COUNCIL_MIN_QUORUM: "5" }), 4);
  assert.equal(resolveCouncilMinQuorum("3", {}), 3);
});

test("formatCouncilQuorumFailure dumps successful answers and failed seat errors", () => {
  const longAnswer = "x".repeat(COUNCIL_PARTIAL_ANSWER_LIMIT + 250);
  const error = new CouncilQuorumError(
    [
      {
        model: "claude-fable-5-1",
        label: "Fable 5.1",
        answer: longAnswer,
        ok: true,
        attempts: 1,
      },
      {
        model: "fugu-ultra-20260615",
        label: "Fugu Ultra",
        answer: "Keep the Fugu view",
        ok: true,
        attempts: 2,
      },
      {
        model: "gpt-6-astra",
        label: "GPT-6 Astra",
        answer: "",
        ok: false,
        attempts: 3,
        error: "empty response",
      },
      {
        model: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro Preview",
        answer: "Gemini view",
        ok: true,
        attempts: 1,
      },
      {
        model: "grok-4.6",
        label: "Grok 4.6",
        answer: "Grok view",
        ok: true,
        attempts: 1,
      },
    ],
    5,
  );

  const dump = formatCouncilQuorumFailure(error);
  assert.match(dump, /no council opinion was produced/);
  assert.match(dump, /Keep the Fugu view/);
  assert.match(dump, /Gemini view/);
  assert.match(dump, /Grok view/);
  assert.match(dump, /GPT-6 Astra/);
  assert.match(dump, /empty response/);
  assert.match(dump, /\[truncated\]/);
  assert.ok(dump.includes("x".repeat(COUNCIL_PARTIAL_ANSWER_LIMIT)));
  assert.equal(
    dump.includes("x".repeat(COUNCIL_PARTIAL_ANSWER_LIMIT + 1)),
    false,
  );
});

test("empty Claude text diagnostics include stop_reason, block types, and max_tokens", async () => {
  const { describeEmptyClaudeText } = await import("../claude");
  const message = describeEmptyClaudeText(
    {
      stop_reason: "max_tokens",
      content: [
        { type: "thinking" },
        { type: "thinking" },
        { type: "text", text: "" },
      ],
    },
    8000,
  );
  assert.match(message, /stop_reason=max_tokens/);
  assert.match(message, /"thinking":2/);
  assert.match(message, /"text":1/);
  assert.match(message, /max_tokens_hit=true/);
  assert.match(message, /max_tokens=8000/);
  assert.doesNotMatch(message, /invent|thinking text/i);
});

test("duplicate model configuration is rejected before any provider call", async () => {
  let calls = 0;
  const duplicateSeats = resolveCouncilSeats({
    COUNCIL_ANTHROPIC_MODEL: "same-model",
    COUNCIL_SAKANA_MODEL: "same-model",
  });

  await assert.rejects(
    () =>
      conveneCouncilWithCompleter(
        { question: "Review this matter." },
        async () => {
          calls += 1;
          return "answer";
        },
        { ...noDelay, seats: duplicateSeats },
      ),
    /every seat must use a distinct model/,
  );
  assert.equal(calls, 0);
});
