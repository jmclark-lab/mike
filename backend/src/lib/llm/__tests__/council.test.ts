import assert from "node:assert/strict";
import test from "node:test";
import {
  COUNCIL_JUDGE,
  COUNCIL_MEMBERS,
  conveneCouncilWithCompleter,
} from "../council";

test("the council invokes each declared member and the judge exactly once", async () => {
  const invoked: string[] = [];
  const result = await conveneCouncilWithCompleter(
    { question: "What is the safer contractual position?", context: "Agreed facts." },
    async ({ model }) => {
      invoked.push(model);
      return model === COUNCIL_JUDGE ? "Reconciled answer" : `Independent answer from ${model}`;
    },
  );

  assert.deepEqual(invoked.slice(0, COUNCIL_MEMBERS.length).sort(), [...COUNCIL_MEMBERS].sort());
  assert.equal(invoked.at(-1), COUNCIL_JUDGE);
  assert.equal(invoked.length, COUNCIL_MEMBERS.length + 1);
  assert.equal(result.respondedCount, 4);
  assert.match(result.finalAnswer, /Reconciled answer/);
});

test("a failed member remains failed instead of being silently substituted", async () => {
  const failed = COUNCIL_MEMBERS[1];
  const invoked: string[] = [];
  const result = await conveneCouncilWithCompleter(
    { question: "Review this matter." },
    async ({ model }) => {
      invoked.push(model);
      if (model === failed) throw new Error("provider unavailable");
      return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
    },
  );

  assert.equal(invoked.filter((model) => model === failed).length, 1);
  assert.equal(result.members.find((member) => member.model === failed)?.ok, false);
  assert.equal(result.respondedCount, 3);
});
