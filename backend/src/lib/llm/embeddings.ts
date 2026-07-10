/**
 * Embeddings client for Mike's knowledge base (RAG).
 * Uses OpenAI text-embedding-3-small (1536-dim). Reuses OPENAI_API_KEY.
 */
const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
const EMBED_MODEL = "text-embedding-3-small";
export const EMBED_DIM = 1536;

function embedKey(override?: string | null): string {
  return override?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
}

export function isEmbeddingConfigured(): boolean {
  return !!embedKey();
}

/** Embed a batch of texts. Returns one 1536-float vector per input, in order. */
export async function embedTexts(
  texts: string[],
  apiKey?: string | null,
): Promise<number[][]> {
  const key = embedKey(apiKey);
  if (!key) throw new Error("OPENAI_API_KEY not configured for embeddings");
  if (!texts.length) return [];
  const res = await fetch(OPENAI_EMBED_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Embeddings request failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: { embedding: number[]; index: number }[] };
  const rows = (json.data ?? []).slice().sort((a, b) => a.index - b.index);
  return rows.map((r) => r.embedding);
}

export async function embedText(text: string, apiKey?: string | null): Promise<number[]> {
  return (await embedTexts([text], apiKey))[0];
}
