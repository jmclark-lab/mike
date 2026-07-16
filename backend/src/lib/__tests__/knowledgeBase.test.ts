import assert from "node:assert/strict";
import test from "node:test";
import { ingestDocument } from "../knowledgeBase";

type Event = { table: string; op: string; value?: unknown };

function fakeDb(events: Event[]) {
  return {
    from(table: string) {
      let terminal: unknown = { data: null, error: null };
      const query: Record<string, unknown> = {
        select() { events.push({ table, op: "select" }); return query; },
        insert(value: unknown) {
          events.push({ table, op: "insert", value });
          terminal = table === "kb_documents"
            ? { data: { id: "new-document" }, error: null }
            : { data: null, error: null };
          return query;
        },
        update(value: unknown) { events.push({ table, op: "update", value }); return query; },
        delete() { events.push({ table, op: "delete" }); return query; },
        eq() { return query; },
        in() { return query; },
        is() {
          terminal = { data: [{ id: "prior-document" }], error: null };
          return query;
        },
        maybeSingle: async () => terminal,
        single: async () => terminal,
        then(resolve: (value: unknown) => unknown) { return Promise.resolve(terminal).then(resolve); },
      };
      return query;
    },
  };
}

const base = {
  ownerId: "owner",
  title: "Agreement",
  text: "A sufficiently useful agreement clause.",
  driveFileId: "drive-file",
  force: true,
};

test("a failed replacement is deleted before the prior active version is touched", async () => {
  const events: Event[] = [];
  await assert.rejects(
    ingestDocument({
      ...base,
      db: fakeDb(events) as never,
      embedMany: async () => { throw new Error("embedding provider failed"); },
    }),
    /embedding provider failed/,
  );

  assert.ok(events.some((event) => event.table === "kb_documents" && event.op === "delete"));
  assert.equal(events.some((event) => event.table === "kb_documents" && event.op === "update"), false);
});

test("prior versions are superseded only after replacement chunks are stored", async () => {
  const events: Event[] = [];
  const result = await ingestDocument({
    ...base,
    db: fakeDb(events) as never,
    embedMany: async (texts) => texts.map(() => [0.1, 0.2]),
  });

  const chunkInsert = events.findIndex((event) => event.table === "kb_chunks" && event.op === "insert");
  const priorUpdate = events.findIndex((event) => event.table === "kb_documents" && event.op === "update");
  assert.ok(chunkInsert >= 0 && priorUpdate > chunkInsert);
  assert.equal(result.status, "superseded_prior_version");
});
