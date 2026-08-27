/**
 * Private knowledge base (RAG) for Mike Legal AI.
 * Ingests documents (chunk + embed) into Supabase pgvector, and retrieves
 * the most relevant chunks for a query with source citations.
 */
import { createHash } from "crypto";
import type { createServerSupabase } from "./supabase";
import { embedText, embedTexts, isEmbeddingConfigured } from "./llm/embeddings";
import {
  DEFAULT_KB_TENANT,
  resolveIngestTenant,
  resolveSearchTenant,
  tenantLabel,
  type KbTenant,
} from "./kbTenant";

type Db = ReturnType<typeof createServerSupabase>;

export interface KbHit {
  chunk_id: string;
  document_id: string;
  title: string;
  doc_type: string;
  chunk_index: number;
  content: string;
  similarity: number;
  source_tag?: string | null;
  source_url?: string | null;
  tenant?: string | null;
  requested_tenant?: KbTenant | null;
  cross_tenant_fallback?: boolean;
}

/** Stable content hash used for dedupe (sha256 of normalized text). */
export function contentHash(text: string): string {
  const norm = (text || "").replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex");
}

export function isKnowledgeBaseConfigured(): boolean {
  return isEmbeddingConfigured();
}

/** Split text into overlapping chunks on paragraph/sentence boundaries. */
export function chunkText(text: string, size = 1200, overlap = 150): string[] {
  const clean = (text || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(i, end);
      const br = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "));
      if (br > size * 0.5) end = i + br + 1;
    }
    chunks.push(clean.slice(i, end).trim());
    if (end >= clean.length) break;
    i = Math.max(end - overlap, i + 1);
  }
  return chunks.filter(Boolean);
}

export interface IngestParams {
  db: Db;
  ownerId: string;
  title: string;
  text: string;
  docType?: string;
  source?: string;
  sourceRef?: string;
  sourceTag?: string | null;
  tenant?: string | null;
  sourceUrl?: string | null;
  driveFileId?: string | null;
  driveVersion?: string | null;
  mimeType?: string | null;
  force?: boolean;
  apiKeys?: { gemini?: string | null };
  /** Injectable for deterministic tests; production uses embedTexts. */
  embedMany?: typeof embedTexts;
}

export type IngestStatus =
  | "ingested"
  | "duplicate_skipped"
  | "superseded_prior_version";

export interface IngestResult {
  documentId: string;
  chunks: number;
  status: IngestStatus;
  contentHash: string;
}

/**
 * Chunk + embed + store a document, with content-hash dedupe and Drive-version
 * supersede. Returns the document id, chunk count, and status.
 */
export async function ingestDocument(p: IngestParams): Promise<IngestResult> {
  if (!p.embedMany && !isEmbeddingConfigured()) throw new Error("Embeddings not configured (GEMINI_API_KEY).");
  const chunks = chunkText(p.text);
  if (!chunks.length) throw new Error("No text to ingest.");
  const hash = contentHash(p.text);

  // Dedupe by content hash (same bytes already ingested for this owner).
  if (!p.force) {
    const { data: existing } = await p.db
      .from("kb_documents")
      .select("id")
      .eq("owner_id", p.ownerId)
      .eq("content_hash", hash)
      .maybeSingle();
    if (existing) {
      return { documentId: (existing as { id: string }).id, chunks: 0, status: "duplicate_skipped", contentHash: hash };
    }
  }

  // Record prior active versions, but keep them searchable until the new
  // document and every embedding have been stored successfully.
  let priorIds: string[] = [];
  if (p.driveFileId) {
    const { data: prior, error: priorErr } = await p.db
      .from("kb_documents")
      .select("id")
      .eq("owner_id", p.ownerId)
      .eq("drive_file_id", p.driveFileId)
      .is("superseded_at", null);
    if (priorErr) throw new Error(`prior KB version lookup failed: ${priorErr.message}`);
    priorIds = ((prior as { id: string }[]) ?? []).map((row) => row.id);
  }

  const { data: doc, error: docErr } = await p.db
    .from("kb_documents")
    .insert({
      owner_id: p.ownerId,
      title: p.title,
      doc_type: p.docType ?? "contract",
      source: p.source ?? null,
      source_ref: p.sourceRef ?? null,
      source_tag: p.sourceTag ?? null,
      tenant: resolveIngestTenant(p.tenant),
      source_url: p.sourceUrl ?? null,
      content_hash: hash,
      drive_file_id: p.driveFileId ?? null,
      drive_version: p.driveVersion ?? null,
      mime_type: p.mimeType ?? null,
      supersedes_document_id: priorIds[0] ?? null,
    })
    .select("id")
    .single();
  if (docErr || !doc) throw new Error(`kb_documents insert failed: ${docErr?.message}`);
  const documentId = (doc as { id: string }).id;

  const BATCH = 96;
  let stored = 0;
  try {
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const vectors = await (p.embedMany ?? embedTexts)(slice, p.apiKeys?.gemini);
      const rows = slice.map((content, j) => ({
        document_id: documentId,
        owner_id: p.ownerId,
        chunk_index: i + j,
        content,
        embedding: vectors[j] as unknown as number[],
      }));
      const { error: chErr } = await p.db.from("kb_chunks").insert(rows);
      if (chErr) throw new Error(`kb_chunks insert failed: ${chErr.message}`);
      stored += rows.length;
    }
    if (priorIds.length) {
      const { error: supersedeErr } = await p.db
        .from("kb_documents")
        .update({ superseded_at: new Date().toISOString() })
        .in("id", priorIds)
        .eq("owner_id", p.ownerId);
      if (supersedeErr) throw new Error(`prior KB version update failed: ${supersedeErr.message}`);
    }
  } catch (error) {
    // Best-effort rollback keeps a partially embedded replacement out of search.
    await p.db.from("kb_documents").delete().eq("id", documentId).eq("owner_id", p.ownerId);
    throw error;
  }
  return { documentId, chunks: stored, status: priorIds.length ? "superseded_prior_version" : "ingested", contentHash: hash };
}

export interface SearchParams {
  db: Db;
  ownerId: string;
  query: string;
  k?: number;
  docType?: string | null;
  tenant?: string | null;
  apiKeys?: { gemini?: string | null };
  /** Injectable for tests; production uses embedText. */
  embedQuery?: typeof embedText;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü\s]/gi, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Lexical rerank of cosine top-k. Does not change the embedding model. */
export function rerankHits(query: string, hits: KbHit[], k: number): KbHit[] {
  if (hits.length <= 1) return hits.slice(0, k);
  const qTerms = new Set(tokenize(query));
  if (qTerms.size === 0) return hits.slice(0, k);
  const scored = hits.map((h) => {
    const terms = new Set(tokenize(h.content));
    let hit = 0;
    for (const t of qTerms) if (terms.has(t)) hit += 1;
    const coverage = hit / qTerms.size;
    const cosine = Number.isFinite(h.similarity) ? h.similarity : 0;
    return { hit: h, score: 0.6 * cosine + 0.4 * coverage };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.hit);
}

export async function searchKnowledge(p: SearchParams): Promise<KbHit[]> {
  if (!p.embedQuery && !isEmbeddingConfigured()) return [];
  const embedding = await (p.embedQuery ?? embedText)(p.query, p.apiKeys?.gemini);
  const requested = resolveSearchTenant({ explicit: p.tenant, query: p.query });
  const k = p.k ?? 6;
  const oversample = Math.max(k * 2, 8);

  const fetchHits = async (filterTenant: string | null): Promise<KbHit[]> => {
    const { data, error } = await p.db.rpc("match_kb_chunks", {
      query_embedding: embedding as unknown as number[],
      match_owner: p.ownerId,
      match_count: oversample,
      filter_doc_type: p.docType ?? null,
      filter_tenant: filterTenant,
    });
    if (error) throw new Error(`match_kb_chunks failed: ${error.message}`);
    return (data as KbHit[]) ?? [];
  };

  let hits = await fetchHits(requested);
  let usedFallback = false;
  if (requested === "amavita" && hits.length === 0) {
    hits = await fetchHits(null);
    usedFallback = hits.length > 0;
  }

  const ids = [...new Set(hits.map((h) => h.document_id))];
  if (ids.length) {
    const { data: meta } = await p.db
      .from("kb_documents")
      .select("id, source_tag, source_url, tenant")
      .in("id", ids);
    const byId = new Map(
      ((meta as { id: string; source_tag: string | null; source_url: string | null; tenant: string | null }[]) ?? []).map((m) => [m.id, m]),
    );
    for (const h of hits) {
      const m = byId.get(h.document_id);
      if (m) {
        h.source_tag = m.source_tag;
        h.source_url = m.source_url;
        h.tenant = h.tenant ?? m.tenant;
      }
    }
  }

  const ranked = rerankHits(p.query, hits, k);
  for (const h of ranked) {
    h.requested_tenant = requested;
    h.cross_tenant_fallback = usedFallback;
    h.tenant = h.tenant ?? DEFAULT_KB_TENANT;
  }
  return ranked;
}

function allHitsAreOtherTenant(hits: KbHit[], requested: KbTenant): boolean {
  return hits.length > 0 && hits.every((h) => (h.tenant ?? DEFAULT_KB_TENANT) !== requested);
}

/** Format retrieved chunks as a cited context block for the model. */
export function formatKnowledgeForModel(query: string, hits: KbHit[]): string {
  if (!hits.length) {
    return `KNOWLEDGE BASE: no matching passages found for "${query}". The knowledge base may be empty or the topic isn't covered; answer from general knowledge and say so.`;
  }
  const requested = hits[0]?.requested_tenant ?? null;
  const fallback = hits.some((h) => h.cross_tenant_fallback);
  const lines: string[] = [
    `KNOWLEDGE BASE — top ${hits.length} passages for "${query}". Cite sources inline as [KB1], [KB2], … and do not invent content not present here.`,
    "",
  ];
  if (
    requested === "amavita" &&
    (fallback || allHitsAreOtherTenant(hits, "amavita"))
  ) {
    lines.push(
      "TENANT MISMATCH: The question is for Amavita (medical practice). Only bioaccess® (CRO) knowledge-base passages were retrieved. Do not treat bioaccess® playbook or CRO positions as Amavita practice policy. If you use them, say they are bioaccess® CRO reference material only, not Amavita policy.",
      "",
    );
  }
  hits.forEach((h, i) => {
    const tenant = tenantLabel(h.tenant);
    const tag = h.source_tag ? `, ${h.source_tag}` : "";
    const url = h.source_url ? ` — ${h.source_url}` : "";
    lines.push(
      `[KB${i + 1}] ${h.title} (tenant: ${tenant}, ${h.doc_type}${tag}, source ${h.document_id}:${h.chunk_id}, chunk ${h.chunk_index}, similarity ${h.similarity.toFixed(3)})${url}`,
    );
    lines.push(h.content.trim());
    lines.push("");
  });
  lines.push(
    "When you use a passage, cite it as [KBn], name the source document, and name the tenant (bioaccess® vs Amavita) so the reader can trace the claim.",
  );
  return lines.join("\n");
}
