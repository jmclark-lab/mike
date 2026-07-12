/**
 * KB ingestion endpoint. POST /kb/ingest accepts a document from text, a public
 * URL, or an uploaded (base64) file, extracts + OCRs as needed, and ingests it
 * into Mike's knowledge base (chunk + embed + store) with source metadata and
 * content-hash / Drive-version dedupe. Auth: connector service key (acts as the
 * configured KB owner) or a normal user JWT.
 */
import { Router, type Request, type Response } from "express";
import { connectorOrAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { ingestDocument, isKnowledgeBaseConfigured } from "../lib/knowledgeBase";
import { resolveDocument } from "../lib/kbIngest";

export const kbRouter = Router();

kbRouter.post("/ingest", connectorOrAuth, async (req: Request, res: Response) => {
  const ownerId = res.locals.userId as string;
  if (!ownerId) return res.status(401).json({ error: "unauthorized" });
  if (!isKnowledgeBaseConfigured()) {
    return res.status(503).json({ error: "knowledge base not configured (GEMINI_API_KEY missing)" });
  }
  const b = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  const text = str(b.text);
  const url = str(b.url);
  const fileBase64 = str(b.file_base64);
  if (!text && !url && !fileBase64) {
    return res.status(400).json({ error: "Provide one of: text, url, or file_base64." });
  }
  try {
    const resolved = await resolveDocument({
      text,
      url,
      fileBase64,
      filename: str(b.filename),
      mimeType: str(b.mime_type),
      title: str(b.title),
      geminiKey: process.env.GEMINI_API_KEY ?? null,
    });
    if (!resolved.text || !resolved.text.trim()) {
      return res.status(422).json({ error: "Could not extract any text from the document." });
    }
    const db = createServerSupabase();
    const result = await ingestDocument({
      db,
      ownerId,
      title: resolved.title,
      text: resolved.text,
      docType: str(b.doc_type) ?? "reference",
      source: "kb-ingest",
      sourceRef: str(b.drive_file_id) ? `gdrive:${str(b.drive_file_id)}` : url ? `url:${url}` : undefined,
      sourceTag: str(b.source_tag) ?? "manual",
      sourceUrl: str(b.source_url) ?? url,
      driveFileId: str(b.drive_file_id),
      driveVersion: str(b.drive_version),
      mimeType: resolved.mimeType,
      force: b.force === true,
      apiKeys: { gemini: process.env.GEMINI_API_KEY ?? null },
    });
    return res.json({
      document_id: result.documentId,
      title: resolved.title,
      source_tag: str(b.source_tag) ?? "manual",
      chunks: result.chunks,
      content_hash: result.contentHash,
      ocr_used: resolved.ocrUsed,
      status: result.status,
    });
  } catch (err) {
    return res.status(500).json({ error: `ingest failed: ${(err as Error).message}` });
  }
});
