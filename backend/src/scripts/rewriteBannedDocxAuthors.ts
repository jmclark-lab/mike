/**
 * Rewrite stored .docx author attributes that are Mike or another banned
 * AI label. The replacement is the document owner's organisation, or
 * "Author" when that is missing or banned. Body text is not changed.
 * Dry-run unless --apply is passed.
 *
 *   npx tsx src/scripts/rewriteBannedDocxAuthors.ts
 *   npx tsx src/scripts/rewriteBannedDocxAuthors.ts --apply
 *   npx tsx src/scripts/rewriteBannedDocxAuthors.ts --document-id <uuid> --apply
 *
 * Logs version ids and rewrite counts only. Does not print document text.
 */
import "dotenv/config";
import { createServerSupabase } from "../lib/supabase";
import { downloadFile, uploadFile } from "../lib/storage";
import {
  bufferToArrayBuffer,
  DOCX_MIME,
  resolveTrackedChangeAuthor,
  rewriteBannedDocxAuthors,
  trackedChangeAuthorForUser,
} from "../lib/outboundAttribution";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const onlyDocumentId = argValue("--document-id");
  const db = createServerSupabase();
  const pageSize = 200;
  let from = 0;
  let scanned = 0;
  let changed = 0;

  for (;;) {
    let query = db
      .from("document_versions")
      .select("id, document_id, storage_path, file_type, filename")
      .is("deleted_at", null)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (onlyDocumentId) query = query.eq("document_id", onlyDocumentId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    for (const row of rows) {
      const fileType = typeof row.file_type === "string" ? row.file_type : "";
      const filename = typeof row.filename === "string" ? row.filename : "";
      const storagePath =
        typeof row.storage_path === "string" ? row.storage_path : "";
      const isDocx =
        fileType === "docx" || filename.toLowerCase().endsWith(".docx");
      if (!isDocx || !storagePath) continue;
      scanned += 1;
      const raw = await downloadFile(storagePath);
      if (!raw) {
        console.log(`${row.id} missing-bytes`);
        continue;
      }
      const documentId =
        typeof row.document_id === "string" ? row.document_id : "";
      const { data: owner } = await db
        .from("documents")
        .select("user_id")
        .eq("id", documentId)
        .maybeSingle();
      const ownerId = typeof owner?.user_id === "string" ? owner.user_id : "";
      const author = ownerId
        ? await trackedChangeAuthorForUser(db, ownerId)
        : resolveTrackedChangeAuthor();
      const rewritten = await rewriteBannedDocxAuthors(Buffer.from(raw), author);
      if (rewritten.rewritten === 0) continue;
      changed += 1;
      console.log(
        `${row.id} document=${documentId} authors=${rewritten.rewritten} ${apply ? "write" : "dry-run"}`,
      );
      if (apply) {
        await uploadFile(
          storagePath,
          bufferToArrayBuffer(rewritten.bytes),
          DOCX_MIME,
        );
      }
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }

  console.error(
    `${apply ? "updated" : "would update"} ${changed} of ${scanned} docx version(s)`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
