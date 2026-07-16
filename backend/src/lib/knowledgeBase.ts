/**
 * Private knowledge base (RAG) for Mike Legal AI.
 * Ingests documents (chunk + embed) into Supabase pgvector, and retrieves
 * the most relevant chunks for a query with source citations.
 */
import { createHash } from "crypto";
import type { createServerSupabase } from "./supabase";
import { embedText, embedTexts, isEmbeddingConfigured } from "./llm/embeddings";

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
  apiKeys?: { gemini?: string | null };
}

export async function searchKnowledge(p: SearchParams): Promise<KbHit[]> {
  if (!isEmbeddingConfigured()) return [];
  const embedding = await embedText(p.query, p.apiKeys?.gemini);
  const { data, error } = await p.db.rpc("match_kb_chunks", {
    query_embedding: embedding as unknown as number[],
    match_owner: p.ownerId,
    match_count: p.k ?? 6,
    filter_doc_type: p.docType ?? null,
  });
  if (error) throw new Error(`match_kb_chunks failed: ${error.message}`);
  const hits = (data as KbHit[]) ?? [];
  // Enrich with source metadata (tag + url) for citations, without changing the RPC.
  const ids = [...new Set(hits.map((h) => h.document_id))];
  if (ids.length) {
    const { data: meta } = await p.db
      .from("kb_documents")
      .select("id, source_tag, source_url")
      .in("id", ids);
    const byId = new Map(
      ((meta as { id: string; source_tag: string | null; source_url: string | null }[]) ?? []).map((m) => [m.id, m]),
    );
    for (const h of hits) {
      const m = byId.get(h.document_id);
      if (m) {
        h.source_tag = m.source_tag;
        h.source_url = m.source_url;
      }
    }
  }
  return hits;
}

/** Format retrieved chunks as a cited context block for the model. */
export function formatKnowledgeForModel(query: string, hits: KbHit[]): string {
  if (!hits.length) {
    return `KNOWLEDGE BASE: no matching passages found for "${query}". The knowledge base may be empty or the topic isn't covered; answer from general knowledge and say so.`;
  }
  const lines: string[] = [
    `KNOWLEDGE BASE — top ${hits.length} passages for "${query}". Cite sources inline as [KB1], [KB2], … and do not invent content not present here.`,
    "",
  ];
  hits.forEach((h, i) => {
    const tag = h.source_tag ? `, ${h.source_tag}` : "";
    const url = h.source_url ? ` — ${h.source_url}` : "";
    lines.push(`[KB${i + 1}] ${h.title} (${h.doc_type}${tag}, source ${h.document_id}:${h.chunk_id}, chunk ${h.chunk_index}, similarity ${h.similarity.toFixed(3)})${url}`);
    lines.push(h.content.trim());
    lines.push("");
  });
  lines.push(
    "When you use a passage, cite it as [KBn] and name the source document (and its link if shown) so the reader can trace the claim.",
  );
  return lines.join("\n");
}
