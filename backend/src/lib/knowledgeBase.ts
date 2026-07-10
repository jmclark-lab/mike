/**
 * Private knowledge base (RAG) for Mike Legal AI.
 * Ingests documents (chunk + embed) into Supabase pgvector, and retrieves
 * the most relevant chunks for a query with source citations.
 */
import type { createServerSupabase } from "./supabase";
import { embedText, embedTexts, isEmbeddingConfigured } from "./llm/embeddings";

type Db = ReturnType<typeof createServerSupabase>;

export interface KbHit {
  document_id: string;
  title: string;
  doc_type: string;
  chunk_index: number;
  content: string;
  similarity: number;
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
  apiKeys?: { gemini?: string | null };
}

/** Chunk + embed + store a document. Returns the new document id and chunk count. */
export async function ingestDocument(p: IngestParams): Promise<{ documentId: string; chunks: number }> {
  if (!isEmbeddingConfigured()) throw new Error("Embeddings not configured (OPENAI_API_KEY).");
  const chunks = chunkText(p.text);
  if (!chunks.length) throw new Error("No text to ingest.");

  const { data: doc, error: docErr } = await p.db
    .from("kb_documents")
    .insert({
      owner_id: p.ownerId,
      title: p.title,
      doc_type: p.docType ?? "contract",
      source: p.source ?? null,
      source_ref: p.sourceRef ?? null,
    })
    .select("id")
    .single();
  if (docErr || !doc) throw new Error(`kb_documents insert failed: ${docErr?.message}`);
  const documentId = (doc as { id: string }).id;

  const BATCH = 96;
  let stored = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    const vectors = await embedTexts(slice, p.apiKeys?.gemini);
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
  return { documentId, chunks: stored };
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
  return (data as KbHit[]) ?? [];
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
    lines.push(`[KB${i + 1}] ${h.title} (${h.doc_type}, chunk ${h.chunk_index}, similarity ${h.similarity.toFixed(3)})`);
    lines.push(h.content.trim());
    lines.push("");
  });
  return lines.join("\n");
}
