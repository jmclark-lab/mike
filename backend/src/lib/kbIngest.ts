/**
 * Ingestion front-end for Mike's KB: resolve a document from text / URL /
 * uploaded bytes, extract its text (PDF, DOCX, MD, TXT), OCR scanned PDFs via
 * Gemini multimodal, and hand off to ingestDocument (chunk + embed + store).
 */
import { GoogleGenAI } from "@google/genai";
import { extractPdfText } from "./chatTools";

const OCR_MODEL = "gemini-3-flash-preview";
const MIN_PDF_TEXT = 80; // below this we assume the PDF is scanned/image-only

export interface ResolvedDoc {
  text: string;
  mimeType: string;
  title: string;
  ocrUsed: boolean;
}

function extFromName(name: string): string {
  const m = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

function titleFromName(name: string): string {
  const base = (name || "").split(/[\\/]/).pop() || "Untitled document";
  return decodeURIComponent(base).replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").trim() || "Untitled document";
}

async function geminiOcrPdf(buf: Buffer, apiKey: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });
  const resp = await ai.models.generateContent({
    model: OCR_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "application/pdf", data: buf.toString("base64") } },
          {
            text:
              "Transcribe ALL text in this document verbatim, preserving reading order. Render tables as readable text (rows/columns). Do not summarize, translate, or add commentary — output only the document's text content.",
          },
        ],
      },
    ],
  });
  const anyResp = resp as unknown as {
    text?: string;
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  if (anyResp.text && anyResp.text.trim()) return anyResp.text;
  const parts = anyResp.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text || "").join("").trim();
}

export interface ResolveParams {
  text?: string | null;
  url?: string | null;
  fileBase64?: string | null;
  filename?: string | null;
  mimeType?: string | null;
  title?: string | null;
  geminiKey?: string | null;
}

/** Resolve + extract text from whichever source was provided. */
export async function resolveDocument(p: ResolveParams): Promise<ResolvedDoc> {
  // 1) Raw text.
  if (p.text && p.text.trim()) {
    return { text: p.text, mimeType: "text/plain", title: p.title?.trim() || "Untitled document", ocrUsed: false };
  }

  // 2) Fetch bytes (URL or base64 upload).
  let buf: Buffer;
  let name = p.filename || "";
  let mime = (p.mimeType || "").toLowerCase();
  if (p.url && p.url.trim()) {
    const res = await fetch(p.url);
    if (!res.ok) throw new Error(`Fetch failed (${res.status}) for ${p.url}`);
    buf = Buffer.from(await res.arrayBuffer());
    mime = mime || (res.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!name) name = p.url;
  } else if (p.fileBase64) {
    buf = Buffer.from(p.fileBase64, "base64");
  } else {
    throw new Error("Provide one of: text, url, or fileBase64.");
  }

  const ext = extFromName(name);
  const title = p.title?.trim() || titleFromName(name);
  const isPdf = mime.includes("pdf") || ext === "pdf" || (buf.length > 4 && buf.slice(0, 4).toString("latin1") === "%PDF");
  const isDocx =
    mime.includes("wordprocessingml") || ext === "docx" ||
    (buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b && (ext === "docx" || mime.includes("word")));

  let text = "";
  let ocrUsed = false;
  if (isPdf) {
    try {
      text = await extractPdfText(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    } catch {
      text = "";
    }
    if (text.trim().length < MIN_PDF_TEXT) {
      const key = p.geminiKey || process.env.GEMINI_API_KEY || "";
      if (!key) throw new Error("Scanned/image PDF needs OCR but no GEMINI_API_KEY is configured.");
      text = await geminiOcrPdf(buf, key);
      ocrUsed = true;
    }
    return { text, mimeType: "application/pdf", title, ocrUsed };
  }
  if (isDocx) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: buf });
    return { text: result.value || "", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", title, ocrUsed: false };
  }
  // md / txt / csv / anything else → treat as UTF-8 text.
  return { text: buf.toString("utf8"), mimeType: mime || "text/plain", title, ocrUsed: false };
}
