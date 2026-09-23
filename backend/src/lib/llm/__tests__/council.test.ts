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

test("default council seats are four providers including Fable 5.1 and Grok 4.7", () => {
  const seats = resolveCouncilSeats({});
  assert.equal(seats.length, 4);
  assert.equal(seats[0].model, "claude-fable-5-1");
  assert.equal(seats[0].label, "Fable 5.1");
  assert.equal(seats[1].provider, "openai");
  assert.equal(seats[1].model, "gpt-6-astra");
  assert.equal(seats[1].label, "GPT-6 Astra");
  assert.equal(seats[2].model, "gemini-3.1-pro-preview");
  assert.equal(seats[3].provider, "xai");
  assert.equal(seats[3].model, "grok-4.7");
  assert.equal(seats[3].label, "Grok 4.7");
  assert.equal(seats[0].maxTokens, 32000);
  assert.equal(seats[1].maxTokens, 16384);
  assert.equal(seats[3].maxTokens, 8000);
  assert.equal(
    seats.some((seat) => seat.model.startsWith("fugu-") || seat.provider === ("sakana" as never)),
    false,
  );
  assert.equal(COUNCIL_MEMBERS.length, 4);
  assert.deepEqual(COUNCIL_MEMBERS, [
    "claude-fable-5-1",
    "gpt-6-astra",
    "gemini-3.1-pro-preview",
    "grok-4.7",
  ]);
});

test("the council invokes all four declared members before the judge", async () => {
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
  assert.equal(result.respondedCount, 4);
  assert.match(result.finalAnswer, /mandatory 4\/4 opinions received/);
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
  assert.equal(result.respondedCount, 4);
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
      assert.equal(error.respondedCount, 3);
      assert.equal(error.requiredCount, 4);
      assert.match(error.message, /Gemini 3\.1 Pro Preview/);
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
      "gpt-6-astra",
      "gemini-3.5-pro",
      "grok-required",
    ],
  );
  assert.equal(
    seats.some((seat) => seat.model.includes("fugu")),
    false,
  );
  assert.equal(seats[1].label, "GPT-6 Astra");
  assert.equal(seats[1].reasoningEffort, "xhigh");
  assert.equal(seats[0].maxTokens, 32000);
  assert.equal(seats[1].maxTokens, 32000);
  assert.equal(seats[2].maxTokens, 6000);
  assert.equal(seats[2].label, "Gemini 3.5 Pro");
  assert.equal(seats[3].provider, "xai");
  assert.equal(seats[3].label, "Grok 4.7");
  assert.equal(seats[3].maxTokens, 12000);
});

test("the Anthropic council call receives the raised token budget", async () => {
  const observed = new Map<string, number | undefined>();
  await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model, maxTokens }) => {
      if (model === "claude-fable-5-1" || model === "gpt-6-astra") {
        observed.set(model, maxTokens);
      }
      return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
    },
    noDelay,
  );

  assert.equal(observed.get("claude-fable-5-1"), 32000);
  assert.equal(observed.get("gpt-6-astra"), 16384);
  assert.equal(observed.has("fugu-ultra-20260615"), false);
});

test("the xAI council call receives the Grok 4.7 token budget", async () => {
  let observed: { maxTokens?: number } | undefined;
  await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model, maxTokens }) => {
      if (model === "grok-4.7") observed = { maxTokens };
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

test("a three-seat configuration is rejected before any provider call", async () => {
  let calls = 0;
  const threeSeats = resolveCouncilSeats({}).slice(0, 3);

  await assert.rejects(
    () =>
      conveneCouncilWithCompleter(
        { question: "Review this matter." },
        async () => {
          calls += 1;
          return "answer";
        },
        { ...noDelay, seats: threeSeats },
      ),
    /exactly 4 seats are required, got 3/,
  );
  assert.equal(calls, 0);
});

test("the council judge defaults to Opus 5.5 and is env-overridable", () => {
  assert.equal(COUNCIL_JUDGE, "claude-opus-5-5");
  assert.equal(resolveCouncilJudge({}), "claude-opus-5-5");
  assert.equal(
    resolveCouncilJudge({ COUNCIL_JUDGE: "claude-opus-4-8" }),
    "claude-opus-4-8",
  );
});

test("the council judge call receives the Opus 5.5 token budget", async () => {
  let observed: { model?: string; maxTokens?: number } | undefined;
  const result = await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model, maxTokens }) => {
      if (model === COUNCIL_JUDGE) observed = { model, maxTokens };
      return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
    },
    noDelay,
  );

  assert.deepEqual(observed, { model: "claude-opus-5-5", maxTokens: 16000 });
  assert.match(result.finalAnswer, /reconciled by Opus 5\.5/);
});

test("min_quorum=3 with one empty seat still judges the successful opinions", async () => {
  const empty = COUNCIL_MEMBERS[0];
  const invoked: string[] = [];
  let judgeUser = "";
  let judgeSystem = "";
  const result = await conveneCouncilWithCompleter(
    { question: "Review this matter.", minQuorum: 3 },
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

  assert.equal(result.respondedCount, 3);
  assert.equal(invoked.filter((model) => model === empty).length, 2);
  assert.equal(invoked.includes(COUNCIL_JUDGE), true);
  assert.match(result.finalAnswer, /3\/4 opinions received/);
  assert.match(result.finalAnswer, /failed: Fable 5\.1/);
  assert.match(result.finalAnswer, /reconciled by Opus 5\.5/);
  assert.doesNotMatch(result.finalAnswer, /mandatory 4\/4/);
  assert.match(judgeUser, /FAILED SEATS/);
  assert.match(judgeUser, /Fable 5\.1/);
  assert.match(judgeUser, /Answer from gpt-6-astra/);
  assert.doesNotMatch(judgeUser, /fugu-/);
  assert.doesNotMatch(judgeUser, /Answer from claude-fable-5-1/);
  assert.match(judgeSystem, /do not invent/i);
  assert.equal(
    result.members.find((member) => member.model === empty)?.ok,
    false,
  );
});

test("min_quorum above the seat count is clamped and one empty seat still fails", async () => {
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
      assert.equal(error.respondedCount, 3);
      assert.equal(error.requiredCount, 4);
      assert.match(error.message, /Grok 4\.7/);
      assert.equal(
        error.members.filter((member) => member.ok).length,
        3,
      );
      return true;
    },
  );

  assert.equal(invoked.filter((model) => model === empty).length, 2);
  assert.equal(invoked.includes(COUNCIL_JUDGE), false);
});

test("COUNCIL_MIN_QUORUM env is clamped to 1–4 and overridden by the call", () => {
  assert.equal(resolveCouncilMinQuorum(undefined, {}), 4);
  assert.equal(resolveCouncilMinQuorum(undefined, { COUNCIL_MIN_QUORUM: "3" }), 3);
  assert.equal(resolveCouncilMinQuorum(undefined, { COUNCIL_MIN_QUORUM: "0" }), 1);
  assert.equal(resolveCouncilMinQuorum(undefined, { COUNCIL_MIN_QUORUM: "9" }), 4);
  assert.equal(resolveCouncilMinQuorum(3, { COUNCIL_MIN_QUORUM: "4" }), 3);
  assert.equal(resolveCouncilMinQuorum("2", {}), 2);
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
        model: "grok-4.7",
        label: "Grok 4.7",
        answer: "Grok view",
        ok: true,
        attempts: 1,
      },
    ],
    4,
  );

  const dump = formatCouncilQuorumFailure(error);
  assert.match(dump, /no council opinion was produced/);
  assert.doesNotMatch(dump, /Fugu|fugu-|sakana/i);
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
    COUNCIL_OPENAI_MODEL: "same-model",
    COUNCIL_SAKANA_MODEL: "fugu-ignored",
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
