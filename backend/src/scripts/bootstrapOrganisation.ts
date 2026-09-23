/**
 * Set user_profiles.organisation without inventing a name and without
 * overwriting a safe company value.
 *
 *   npx tsx src/scripts/bootstrapOrganisation.ts --list-missing
 *   npx tsx src/scripts/bootstrapOrganisation.ts --user-id <uuid> --organisation "bioaccess"
 *   npx tsx src/scripts/bootstrapOrganisation.ts --user-id <uuid> --organisation "Amavita Research" --force
 *
 * Prints user ids only. Does not print emails or display names.
 * Refuses Mike, AI, legal assistant, and the other banned author labels.
 * --force is required to replace an organisation that is already safe.
 */
import "dotenv/config";
import { createServerSupabase } from "../lib/supabase";
import {
  isSafeCompanyAuthor,
  rejectedOrganisationDetail,
} from "../lib/outboundAttribution";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

async function listMissing() {
  const db = createServerSupabase();
  const pageSize = 500;
  let from = 0;
  let printed = 0;
  for (;;) {
    const { data, error } = await db
      .from("user_profiles")
      .select("user_id, organisation")
      .order("user_id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    for (const row of rows) {
      const organisation =
        typeof row.organisation === "string" ? row.organisation : "";
      if (isSafeCompanyAuthor(organisation)) continue;
      const userId = typeof row.user_id === "string" ? row.user_id : "";
      if (!userId) continue;
      console.log(userId);
      printed += 1;
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  console.error(`listed ${printed} profile(s) with no safe organisation`);
}

async function setOrganisation(userId: string, organisation: string, force: boolean) {
  const detail = rejectedOrganisationDetail(organisation);
  if (detail) throw new Error(detail);
  const db = createServerSupabase();
  const { data, error } = await db
    .from("user_profiles")
    .select("user_id, organisation")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`No user_profiles row for ${userId}`);
  const current =
    typeof data.organisation === "string" ? data.organisation : null;
  if (isSafeCompanyAuthor(current) && !force) {
    throw new Error(
      "This profile already has a safe organisation. Pass --force to replace it.",
    );
  }
  const { error: updateError } = await db
    .from("user_profiles")
    .update({
      organisation: organisation.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
  if (updateError) throw new Error(updateError.message);
  console.log(`updated ${userId}`);
}

async function main() {
  if (process.argv.includes("--list-missing")) {
    await listMissing();
    return;
  }
  const userId = argValue("--user-id");
  const organisation = argValue("--organisation");
  if (!userId || !organisation) {
    throw new Error(
      "Pass --list-missing, or both --user-id and --organisation.",
    );
  }
  await setOrganisation(userId, organisation, process.argv.includes("--force"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
