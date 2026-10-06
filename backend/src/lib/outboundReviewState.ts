/**
 * Sponsor-CI review gate for outbound downloads.
 *
 * Runs only while `isSponsorCiMode()` is on, and only after the existing
 * attribution gate. Open Word comments block the download (422). Tracked
 * changes do not: the caller must send `confirm_tracked_changes=1` or
 * `X-Confirm-Tracked-Changes: 1` (428 until then). A confirmed release is
 * written as one JSON line on stdout. There is no audit table.
 *
 * A comment is open when it is in word/comments.xml and no
 * word/commentsExtended.xml entry with `w15:done="1"` matches that
 * comment's last paragraph `w14:paraId` via `w15:paraId` or
 * `w15:paraIdParent`. A comment with no extended entry is open.
 */

import JSZip from "jszip";
import { isSponsorCiMode } from "./sponsorCiMode";

export type OpenComment = {
  id: string;
  author: string;
  excerpt: string;
  documentId?: string;
  filename?: string;
};

export type TrackedChangeCounts = {
  insertions: number;
  deletions: number;
  moveFrom: number;
  moveTo: number;
  formatting: number;
  total: number;
};

export type CommentDocumentSummary = {
  documentId: string;
  filename: string;
  versionId: string | null;
  count: number;
};

export type TrackedDocumentSummary = {
  documentId: string;
  filename: string;
  versionId: string | null;
  counts: TrackedChangeCounts;
};

export type OutboundReviewAudit = {
  userId: string;
  documentId: string;
  versionId: string | null;
  route: string;
};

export type ZipReviewMember = {
  bytes: Buffer;
  filename: string;
  documentId: string;
  versionId: string | null;
};

const CONFIRM_QUERY = "confirm_tracked_changes=1";
const CONFIRM_HEADER = "X-Confirm-Tracked-Changes: 1";

export class OutboundOpenCommentsError extends Error {
  readonly code = "outbound_open_comments_blocked" as const;
  readonly count: number;
  readonly comments: OpenComment[];
  readonly documents?: CommentDocumentSummary[];

  constructor(comments: OpenComment[], documents?: CommentDocumentSummary[]) {
    const count = comments.length;
    const noun = count === 1 ? "comment" : "comments";
    const docNote =
      documents && documents.length > 0
        ? ` across ${documents.length} document${documents.length === 1 ? "" : "s"} (${documents
            .map((doc) => doc.filename)
            .join(", ")})`
        : "";
    super(
      `Export blocked: ${count} open ${noun}${docNote}. Nothing was downloaded or sent.`,
    );
    this.name = "OutboundOpenCommentsError";
    this.count = count;
    this.comments = comments;
    this.documents = documents;
  }
}

export class OutboundTrackedChangesNeedsConfirmationError extends Error {
  readonly code = "outbound_tracked_changes_needs_confirmation" as const;
  readonly counts: TrackedChangeCounts;
  readonly documents?: TrackedDocumentSummary[];

  constructor(
    counts: TrackedChangeCounts,
    documents?: TrackedDocumentSummary[],
  ) {
    const scope =
      documents && documents.length > 0
        ? ` across ${documents.length} document${documents.length === 1 ? "" : "s"} (${documents
            .map((doc) => `${doc.filename}: ${doc.counts.total}`)
            .join(", ")})`
        : "";
    super(
      `This download has ${countsPhrase(counts)}${scope}. Nothing was downloaded or sent.`,
    );
    this.name = "OutboundTrackedChangesNeedsConfirmationError";
    this.counts = counts;
    this.documents = documents;
  }
}

export function trackedChangesConfirmed(req: {
  query: { confirm_tracked_changes?: unknown };
  get(name: string): string | undefined;
}): boolean {
  const raw = req.query.confirm_tracked_changes;
  const query = Array.isArray(raw) ? raw[0] : raw;
  if (typeof query === "string" && query.trim() === "1") return true;
  const header = req.get("X-Confirm-Tracked-Changes");
  return typeof header === "string" && header.trim() === "1";
}

export function outboundReviewHttpError(
  err: unknown,
): { status: 422 | 428; body: Record<string, unknown> } | null {
  if (err instanceof OutboundOpenCommentsError) {
    const body: Record<string, unknown> = {
      code: err.code,
      detail: err.message,
      count: err.count,
      comments: err.comments.map((comment) => {
        const row: Record<string, string> = {
          id: comment.id,
          author: comment.author,
          excerpt: comment.excerpt,
        };
        if (comment.documentId) row.documentId = comment.documentId;
        if (comment.filename) row.filename = comment.filename;
        return row;
      }),
    };
    if (err.documents && err.documents.length > 0) body.documents = err.documents;
    return { status: 422, body };
  }
  if (err instanceof OutboundTrackedChangesNeedsConfirmationError) {
    const body: Record<string, unknown> = {
      code: err.code,
      detail: err.message,
      counts: err.counts,
      confirm: { query: CONFIRM_QUERY, header: CONFIRM_HEADER },
    };
    if (err.documents && err.documents.length > 0) body.documents = err.documents;
    return { status: 428, body };
  }
  return null;
}

export function sendOutboundReviewError(
  res: { status(code: number): { json(body: unknown): unknown } },
  err: unknown,
): boolean {
  const http = outboundReviewHttpError(err);
  if (!http) return false;
  res.status(http.status).json(http.body);
  return true;
}

export async function gateOutboundReview(
  bytes: Buffer,
  _filename: string,
  options: {
    confirmed: boolean;
    env?: NodeJS.ProcessEnv;
    audit?: OutboundReviewAudit | null;
  },
): Promise<void> {
  if (!isSponsorCiMode(options.env)) return;
  const finding = await inspectDocxReviewState(bytes);
  if (!finding) return;
  if (finding.comments.length > 0) {
    throw new OutboundOpenCommentsError(finding.comments);
  }
  if (finding.counts.total > 0 && !options.confirmed) {
    throw new OutboundTrackedChangesNeedsConfirmationError(finding.counts);
  }
  if (finding.counts.total > 0 && options.confirmed && options.audit) {
    logOutboundTrackedChangesConfirmedRelease({
      ...options.audit,
      counts: finding.counts,
    });
  }
}

/**
 * Zip rule: any open comment blocks the whole archive (422), even when
 * the confirm flag is set. Otherwise any tracked changes without
 * confirmation return 428 listing each document and its counts.
 */
export async function gateOutboundZipMembers(
  members: ZipReviewMember[],
  options: {
    confirmed: boolean;
    userId: string;
    route: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  if (!isSponsorCiMode(options.env)) return;
  const reviewed: Array<{ member: ZipReviewMember; finding: DocxReviewFinding }> =
    [];
  for (const member of members) {
    const finding = await inspectDocxReviewState(member.bytes);
    if (!finding) continue;
    if (finding.comments.length === 0 && finding.counts.total === 0) continue;
    reviewed.push({ member, finding });
  }

  const withComments = reviewed.filter((row) => row.finding.comments.length > 0);
  if (withComments.length > 0) {
    const comments = withComments.flatMap((row) =>
      row.finding.comments.map((comment) => ({
        ...comment,
        documentId: row.member.documentId,
        filename: row.member.filename,
      })),
    );
    const documents = withComments.map((row) => ({
      documentId: row.member.documentId,
      filename: row.member.filename,
      versionId: row.member.versionId,
      count: row.finding.comments.length,
    }));
    throw new OutboundOpenCommentsError(comments, documents);
  }

  const withTracked = reviewed.filter((row) => row.finding.counts.total > 0);
  if (withTracked.length === 0) return;
  if (!options.confirmed) {
    const documents = withTracked.map((row) => ({
      documentId: row.member.documentId,
      filename: row.member.filename,
      versionId: row.member.versionId,
      counts: row.finding.counts,
    }));
    throw new OutboundTrackedChangesNeedsConfirmationError(
      sumCounts(withTracked.map((row) => row.finding.counts)),
      documents,
    );
  }
  for (const row of withTracked) {
    logOutboundTrackedChangesConfirmedRelease({
      userId: options.userId,
      documentId: row.member.documentId,
      versionId: row.member.versionId,
      counts: row.finding.counts,
      route: options.route,
    });
  }
}

export type DocxReviewFinding = {
  comments: OpenComment[];
  counts: TrackedChangeCounts;
};

export async function inspectDocxReviewState(
  bytes: Buffer,
): Promise<DocxReviewFinding | null> {
  const zip = await loadDocxZip(bytes);
  if (!zip) return null;
  const documentXml = await zipText(zip, "word/document.xml");
  if (documentXml == null) return null;

  let counts = zeroCounts();
  counts = addCounts(counts, countTrackedChanges(documentXml));
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name]?.dir) continue;
    const normalized = name.replace(/\\/g, "/");
    if (normalized.toLowerCase() === "word/document.xml") continue;
    if (!isTrackedChangePart(normalized)) continue;
    const xml = await zipText(zip, normalized);
    if (!xml) continue;
    counts = addCounts(counts, countTrackedChanges(xml));
  }

  const commentsXml = await zipText(zip, "word/comments.xml");
  const extendedXml = await zipText(zip, "word/commentsExtended.xml");
  const comments = commentsXml
    ? openCommentsInXml(commentsXml, extendedXml)
    : [];
  return { comments, counts: withTotal(counts) };
}

export function logOutboundTrackedChangesConfirmedRelease(entry: {
  userId: string;
  documentId: string;
  versionId: string | null;
  counts: TrackedChangeCounts;
  route: string;
  timestamp?: string;
}): void {
  console.info(
    JSON.stringify({
      event: "outbound_tracked_changes_confirmed_release",
      userId: entry.userId,
      documentId: entry.documentId,
      versionId: entry.versionId,
      counts: entry.counts,
      route: entry.route,
      timestamp: entry.timestamp ?? new Date().toISOString(),
    }),
  );
}

function countsPhrase(counts: TrackedChangeCounts): string {
  const changes = `${counts.total} open tracked change${counts.total === 1 ? "" : "s"}`;
  const insertions = `${counts.insertions} insertion${counts.insertions === 1 ? "" : "s"}`;
  const deletions = `${counts.deletions} deletion${counts.deletions === 1 ? "" : "s"}`;
  return `${changes} (${insertions}, ${deletions})`;
}

function zeroCounts(): Omit<TrackedChangeCounts, "total"> {
  return {
    insertions: 0,
    deletions: 0,
    moveFrom: 0,
    moveTo: 0,
    formatting: 0,
  };
}

function withTotal(
  counts: Omit<TrackedChangeCounts, "total">,
): TrackedChangeCounts {
  return {
    ...counts,
    total:
      counts.insertions +
      counts.deletions +
      counts.moveFrom +
      counts.moveTo +
      counts.formatting,
  };
}

function addCounts(
  left: Omit<TrackedChangeCounts, "total">,
  right: Omit<TrackedChangeCounts, "total">,
): Omit<TrackedChangeCounts, "total"> {
  return {
    insertions: left.insertions + right.insertions,
    deletions: left.deletions + right.deletions,
    moveFrom: left.moveFrom + right.moveFrom,
    moveTo: left.moveTo + right.moveTo,
    formatting: left.formatting + right.formatting,
  };
}

function sumCounts(rows: TrackedChangeCounts[]): TrackedChangeCounts {
  return withTotal(
    rows.reduce(
      (sum, row) =>
        addCounts(sum, {
          insertions: row.insertions,
          deletions: row.deletions,
          moveFrom: row.moveFrom,
          moveTo: row.moveTo,
          formatting: row.formatting,
        }),
      zeroCounts(),
    ),
  );
}

async function loadDocxZip(bytes: Buffer): Promise<JSZip | null> {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    return null;
  }
  try {
    const zip = await JSZip.loadAsync(bytes);
    return zip;
  } catch {
    return null;
  }
}

async function zipText(zip: JSZip, pathSlash: string): Promise<string | null> {
  const file = zip.file(pathSlash) ?? zip.file(pathSlash.replace(/\//g, "\\"));
  if (!file) return null;
  return file.async("string");
}

function isTrackedChangePart(normalized: string): boolean {
  return /^word\/(?:document|footnotes|endnotes|comments|commentsExtended|header\d*|footer\d*)\.xml$/i.test(
    normalized,
  );
}

const TRACKED_TAG =
  /<(\/?)(mc:Fallback|w:rPrChange|w:pPrChange|w:moveFrom|w:moveTo|w:ins|w:del|w:rPr)\b([^>]*?)>/g;

/**
 * `w:ins` / `w:del` inside `w:rPr` are paragraph-mark revisions. Count
 * those once, as formatting, and do not also count them as insertions or
 * deletions. `mc:Fallback` is skipped so Word's alternate-content copy of
 * the same revision is not counted twice.
 */
export function countTrackedChanges(
  xml: string,
): Omit<TrackedChangeCounts, "total"> {
  const counts = zeroCounts();
  let rPrDepth = 0;
  let fallbackDepth = 0;
  for (const match of xml.matchAll(TRACKED_TAG)) {
    const closing = match[1] === "/";
    const name = match[2];
    const selfClosing = /\/\s*$/.test(match[3] ?? "");
    if (name === "mc:Fallback") {
      if (selfClosing) continue;
      fallbackDepth = closing ? Math.max(0, fallbackDepth - 1) : fallbackDepth + 1;
      continue;
    }
    if (name === "w:rPr") {
      if (selfClosing || fallbackDepth > 0) continue;
      rPrDepth = closing ? Math.max(0, rPrDepth - 1) : rPrDepth + 1;
      continue;
    }
    if (closing || fallbackDepth > 0) continue;
    if (name === "w:rPrChange" || name === "w:pPrChange") {
      counts.formatting += 1;
      continue;
    }
    if (rPrDepth > 0) {
      counts.formatting += 1;
      continue;
    }
    if (name === "w:ins") counts.insertions += 1;
    else if (name === "w:del") counts.deletions += 1;
    else if (name === "w:moveFrom") counts.moveFrom += 1;
    else if (name === "w:moveTo") counts.moveTo += 1;
  }
  return counts;
}

function openCommentsInXml(
  commentsXml: string,
  extendedXml: string | null,
): OpenComment[] {
  const doneParaIds = resolvedParaIds(extendedXml);
  const comments: OpenComment[] = [];
  for (const match of commentsXml.matchAll(
    /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g,
  )) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const paraId = lastParagraphParaId(inner);
    if (paraId && doneParaIds.has(paraId)) continue;
    comments.push({
      id: attr(attrs, "w:id") ?? "",
      author: attr(attrs, "w:author") ?? "",
      excerpt: excerptOf(inner),
    });
  }
  return comments;
}

function resolvedParaIds(extendedXml: string | null): Set<string> {
  const ids = new Set<string>();
  if (!extendedXml) return ids;
  for (const match of extendedXml.matchAll(/<w15:commentEx\b([^>]*?)(?:\/>|>)/g)) {
    const attrs = match[1] ?? "";
    const done = attr(attrs, "w15:done") ?? attr(attrs, "done");
    if (done !== "1") continue;
    const paraId = attr(attrs, "w15:paraId") ?? attr(attrs, "paraId");
    const parent = attr(attrs, "w15:paraIdParent") ?? attr(attrs, "paraIdParent");
    if (paraId) ids.add(paraId);
    if (parent) ids.add(parent);
  }
  return ids;
}

function lastParagraphParaId(inner: string): string | null {
  const paras = [...inner.matchAll(/<w:p\b([^>]*)>/g)];
  if (paras.length === 0) return null;
  const attrs = paras[paras.length - 1]?.[1] ?? "";
  return attr(attrs, "w14:paraId") ?? attr(attrs, "paraId");
}

function excerptOf(inner: string): string {
  const parts: string[] = [];
  for (const match of inner.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)) {
    parts.push(decodeXml(match[1] ?? ""));
  }
  return parts.join("").replace(/\s+/g, " ").trim().slice(0, 120);
}

function attr(source: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"),
  );
  if (!match) return null;
  return decodeXml(match[1] ?? match[2] ?? "").trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
