import assert from "node:assert/strict";
import test from "node:test";
import {
  inferTenant,
  normalizeTenant,
  resolveIngestTenant,
  resolveSearchTenant,
  tenantLabel,
} from "../kbTenant";
import {
  formatKnowledgeForModel,
  ingestDocument,
  rerankHits,
  searchKnowledge,
  type KbHit,
} from "../knowledgeBase";

test("normalizeTenant accepts bioaccess / amavita and rejects junk", () => {
  assert.equal(normalizeTenant("bioaccess"), "bioaccess");
  assert.equal(normalizeTenant("bioaccess®"), "bioaccess");
  assert.equal(normalizeTenant("CRO"), "bioaccess");
  assert.equal(normalizeTenant("Amavita"), "amavita");
  assert.equal(normalizeTenant("manual"), null);
  assert.equal(normalizeTenant(""), null);
  assert.equal(resolveIngestTenant(undefined), "bioaccess");
  assert.equal(resolveIngestTenant("amavita"), "amavita");
});

test("inferTenant prefers Amavita when the question names the practice", () => {
  assert.equal(inferTenant("What is Amavita's standard NDA position?"), "amavita");
  assert.equal(inferTenant("Cite bioaccess® MSA indemnification"), "bioaccess");
  assert.equal(inferTenant("What does this resolution say?"), null);
  assert.equal(
    resolveSearchTenant({
      query: "Amavita retention of records vs bioaccess CRO template",
    }),
    "amavita",
  );
  assert.equal(tenantLabel("amavita"), "Amavita (medical practice)");
  assert.equal(tenantLabel("bioaccess"), "bioaccess® (CRO)");
});

test("ingest stores a tenant tag (fixture, no real Amavita PHI)", async () => {
  const inserts: unknown[] = [];
  const db = {
    from(table: string) {
      const query: Record<string, unknown> = {
        select() { return query; },
        insert(value: unknown) {
          inserts.push({ table, value });
          return query;
        },
        update() { return query; },
        delete() { return query; },
        eq() { return query; },
        in() { return query; },
        is() { return query; },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: { id: "doc-amavita-fixture" }, error: null }),
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return query;
    },
  };
  await ingestDocument({
    db: db as never,
    ownerId: "owner",
    title: "Amavita fixture policy (synthetic)",
    text: "Synthetic Amavita records-retention clause for unit tests only.",
    tenant: "amavita",
    sourceTag: "manual",
    force: true,
    embedMany: async (texts) => texts.map(() => [0.1, 0.2]),
  });
  const docInsert = inserts.find((row) => (row as { table: string }).table === "kb_documents") as
    | { value: { tenant: string } }
    | undefined;
  assert.equal(docInsert?.value.tenant, "amavita");
});

test("search_knowledge prefers Amavita then falls back to bioaccess with a warning", async () => {
  const bioaccessHit: KbHit = {
    chunk_id: "c1",
    document_id: "d-bio",
    title: "Standard MSA",
    doc_type: "template",
    chunk_index: 0,
    content: "bioaccess® CRO indemnification cap is 12 months of fees.",
    similarity: 0.81,
    tenant: "bioaccess",
    source_tag: "playbook",
  };
  let filterSeen: Array<string | null> = [];
  const db = {
    rpc: async (_name: string, args: { filter_tenant?: string | null }) => {
      filterSeen.push(args.filter_tenant ?? null);
      if (args.filter_tenant === "amavita") return { data: [], error: null };
      return { data: [bioaccessHit], error: null };
    },
    from() {
      const query: Record<string, unknown> = {
        select() { return query; },
        in() { return query; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({
            data: [{ id: "d-bio", source_tag: "playbook", source_url: null, tenant: "bioaccess" }],
            error: null,
          }).then(resolve);
        },
      };
      return query;
    },
  };

  const hits = await searchKnowledge({
    db: db as never,
    ownerId: "owner",
    query: "What is Amavita's indemnification cap?",
    tenant: "amavita",
    embedQuery: async () => [0.1, 0.2],
  });

  assert.deepEqual(filterSeen, ["amavita", null]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].tenant, "bioaccess");
  assert.equal(hits[0].cross_tenant_fallback, true);
  assert.equal(hits[0].requested_tenant, "amavita");

  const formatted = formatKnowledgeForModel("What is Amavita's indemnification cap?", hits);
  assert.match(formatted, /TENANT MISMATCH/);
  assert.match(formatted, /tenant: bioaccess® \(CRO\)/);
  assert.match(formatted, /Do not treat bioaccess® playbook/);
});

test("formatKnowledgeForModel cites tenant on matching Amavita fixtures", () => {
  const hits: KbHit[] = [
    {
      chunk_id: "c2",
      document_id: "d-ama",
      title: "Amavita fixture policy (synthetic)",
      doc_type: "regulatory",
      chunk_index: 0,
      content: "Synthetic Amavita retention window is seven years.",
      similarity: 0.9,
      tenant: "amavita",
      source_tag: "manual",
      requested_tenant: "amavita",
      cross_tenant_fallback: false,
    },
  ];
  const formatted = formatKnowledgeForModel("Amavita records retention", hits);
  assert.match(formatted, /tenant: Amavita \(medical practice\)/);
  assert.doesNotMatch(formatted, /TENANT MISMATCH/);
});

test("lexical rerank promotes the passage that actually names the query terms", () => {
  const hits: KbHit[] = [
    {
      chunk_id: "low",
      document_id: "d1",
      title: "Unrelated",
      doc_type: "other",
      chunk_index: 0,
      content: "General commercial terms and payment schedules.",
      similarity: 0.92,
      tenant: "bioaccess",
    },
    {
      chunk_id: "high",
      document_id: "d2",
      title: "Retention",
      doc_type: "regulatory",
      chunk_index: 0,
      content: "Amavita records retention requires seven years of source documents.",
      similarity: 0.71,
      tenant: "amavita",
    },
  ];
  const ranked = rerankHits("Amavita records retention seven years", hits, 2);
  assert.equal(ranked[0].chunk_id, "high");
});
