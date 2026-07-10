/**
 * Embeddings client for Mike's knowledge base (RAG).
 * Uses Google Gemini (gemini-embedding-001) truncated to 1536 dims to match
 * the pgvector column. Reuses GEMINI_API_KEY (the OpenAI account is unfunded).
 * Cosine search is scale-invariant, so no L2 normalization is needed.
 */
import { GoogleGenAI } from "@google/genai";

const EMBED_MODEL = "gemini-embedding-001";
export const EMBED_DIM = 1536;

function embedKey(override?: string | null): string {
  return override?.trim() || process.env.GEMINI_API_KEY?.trim() || "";
}

export function isEmbeddingConfigured(): boolean {
  return !!embedKey();
}

/** Embed a batch of texts. Returns one 1536-float vector per input, in order. */
export async function embedTexts(
  texts: string[],
  apiKey?: string | null,
  taskType: string = "RETRIEVAL_DOCUMENT",
): Promise<number[][]> {
  const key = embedKey(apiKey);
  if (!key) throw new Error("GEMINI_API_KEY not configured for embeddings");
  if (!texts.length) return [];
  const ai = new GoogleGenAI({ apiKey: key });
  const resp = await ai.models.embedContent({
    model: EMBED_MODEL,
    contents: texts,
    config: { outputDimensionality: EMBED_DIM, taskType },
  });
  const embs = resp.embeddings ?? [];
  return embs.map((e) => (e.values ?? []) as number[]);
}

export async function embedText(
  text: string,
  apiKey?: string | null,
  taskType: string = "RETRIEVAL_QUERY",
): Promise<number[]> {
  return (await embedTexts([text], apiKey, taskType))[0];
}
