import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNCIL_JUDGE,
  COUNCIL_MEMBERS,
  CouncilQuorumError,
  conveneCouncilWithCompleter,
  resolveCouncilSeats,
} from "../council";

const noDelay = {
  retryBaseDelayMs: 0,
  sleepFn: async () => undefined,
};

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
      assert.match(error.message, /GPT-5\.6 Sol Ultra/);
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

test("council seats are configurable and Sol Ultra always uses xhigh reasoning", async () => {
  const seats = resolveCouncilSeats({
    COUNCIL_ANTHROPIC_MODEL: "claude-required",
    COUNCIL_SAKANA_MODEL: "fugu-required",
    COUNCIL_OPENAI_MODEL: "gpt-5.6-sol",
    COUNCIL_GEMINI_MODEL: "gemini-3.5-pro",
    COUNCIL_GEMINI_LABEL: "Gemini 3.5 Pro",
  });

  assert.deepEqual(
    seats.map((seat) => seat.model),
    ["claude-required", "fugu-required", "gpt-5.6-sol", "gemini-3.5-pro"],
  );
  assert.equal(seats[2].label, "GPT-5.6 Sol Ultra");
  assert.equal(seats[2].reasoningEffort, "xhigh");
  assert.equal(seats[2].maxTokens, 12000);
  assert.equal(seats[3].label, "Gemini 3.5 Pro");
});

test("the OpenAI council call receives the Sol Ultra reasoning and token budget", async () => {
  let observed: { reasoningEffort?: string; maxTokens?: number } | undefined;
  await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model, reasoningEffort, maxTokens }) => {
      if (model === "gpt-5.6-sol") observed = { reasoningEffort, maxTokens };
      return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
    },
    noDelay,
  );

  assert.deepEqual(observed, { reasoningEffort: "xhigh", maxTokens: 12000 });
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
