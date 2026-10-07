import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import JSZip from "jszip";
import {
  OutboundAttributionError,
  bytesSafeForSignedUrl,
  prepareOutboundFileBytes,
} from "../outboundAttribution";
import {
  OutboundOpenCommentsError,
  OutboundTrackedChangesNeedsConfirmationError,
  countTrackedChanges,
  gateOutboundReview,
  gateOutboundZipMembers,
  inspectDocxReviewState,
  outboundReviewHttpError,
  trackedChangesConfirmed,
  type OutboundReviewAudit,
  type TrackedChangeCounts,
} from "../outboundReviewState";

const sponsorOn = { SPONSOR_CI_MODE: "1" } as NodeJS.ProcessEnv;
const sponsorOff = { SPONSOR_CI_MODE: "0" } as NodeJS.ProcessEnv;

const COMMENT_A = "Internal note: confirm sponsor budget before sending.";
const COMMENT_B = "Reviewer: strike this before CI export.";
const CLEAN_TEXT =
  "RESMOKE4 clean control document. No tracked changes, no comments.";
const ATTRIBUTION =
  "This memo was prepared with Mike, our legal assistant.";

const DEL = `<w:del w:id="101" w:author="PE Test" w:date="2026-10-06T13:00:00Z"><w:r><w:delText>removed</w:delText></w:r></w:del>`;
const INS = `<w:ins w:id="102" w:author="PE Test" w:date="2026-10-06T13:00:00Z"><w:r><w:t>added</w:t></w:r></w:ins>`;

const audit: OutboundReviewAudit = {
  userId: "user-1",
  documentId: "doc-1",
  versionId: "ver-1",
  route: "export",
};

test("clean docx passes the sponsor review gate", async () => {
  const clean = await reviewDocx({ body: `<w:r><w:t>${CLEAN_TEXT}</w:t></w:r>` });
  const sent = await release(clean, false);
  assert.equal(sent.equals(clean), true);
  const finding = await inspectDocxReviewState(sent);
  assert.deepEqual(finding?.comments, []);
  assert.equal(finding?.counts.total, 0);
});

test("comments with no commentsExtended entry are open and block with 422", async () => {
  const bytes = await commentsOnly();
  const lines = await captureInfo(async () => {
    await assert.rejects(
      () => release(bytes, true, audit),
      (err: unknown) => {
        assert.ok(err instanceof OutboundOpenCommentsError);
        assert.equal(err.code, "outbound_open_comments_blocked");
        assert.equal(err.count, 1);
        assert.equal(err.comments[0]?.author, "PE Test");
        assert.equal(err.comments[0]?.excerpt, COMMENT_A);
        assert.match(err.message, /Nothing was downloaded or sent/);
        const http = outboundReviewHttpError(err);
        assert.equal(http?.status, 422);
        assert.equal(http?.body.code, "outbound_open_comments_blocked");
        assert.equal(http?.body.count, 1);
        assert.deepEqual(http?.body.comments, [
          { id: "0", author: "PE Test", excerpt: COMMENT_A },
        ]);
        return true;
      },
    );
  });
  assert.equal(confirmedEvents(lines).length, 0);
});

test("resolved comments (w15:done=1 matched on w14:paraId) pass", async () => {
  const bytes = await resolvedOnly();
  const sent = await release(bytes, false);
  const finding = await inspectDocxReviewState(sent);
  assert.deepEqual(finding?.comments, []);
  assert.equal(finding?.counts.total, 0);
  assert.ok(sent.length > 0);
});

test("a done=1 reply resolves the parent through w15:paraIdParent", async () => {
  const bytes = await reviewDocx({
    body: `<w:r><w:t>Thread.</w:t></w:r>`,
    comments: [
      commentXml("0", "AAAA0001", COMMENT_A),
      commentXml("1", "BBBB0002", "Reply."),
    ],
    extended: [
      `<w15:commentEx w15:paraId="AAAA0001" w15:done="0"/>`,
      `<w15:commentEx w15:paraId="BBBB0002" w15:paraIdParent="AAAA0001" w15:done="1"/>`,
    ],
  });
  const sent = await release(bytes, false);
  const finding = await inspectDocxReviewState(sent);
  assert.deepEqual(finding?.comments, []);
});

test("an extended entry that does not match the comment paraId stays open", async () => {
  const bytes = await reviewDocx({
    body: `<w:r><w:t>Noted.</w:t></w:r>`,
    comments: [commentXml("0", "AAAA0001", COMMENT_A)],
    extended: [
      `<w15:commentEx w15:paraId="FFFF9999" w15:done="1"/>`,
    ],
  });
  await assert.rejects(
    () => release(bytes, false),
    (err: unknown) => {
      assert.ok(err instanceof OutboundOpenCommentsError);
      assert.equal(err.count, 1);
      return true;
    },
  );
});

test("tracked changes without confirmation return 428", async () => {
  const bytes = await trackedOnly();
  const lines = await captureInfo(async () => {
    await assert.rejects(
      () => release(bytes, false, audit),
      (err: unknown) => {
        assert.ok(err instanceof OutboundTrackedChangesNeedsConfirmationError);
        assert.equal(err.code, "outbound_tracked_changes_needs_confirmation");
        assert.deepEqual(err.counts, trackedCounts());
        const http = outboundReviewHttpError(err);
        assert.equal(http?.status, 428);
        assert.equal(http?.body.code, "outbound_tracked_changes_needs_confirmation");
        assert.deepEqual(http?.body.counts, trackedCounts());
        assert.deepEqual(http?.body.confirm, {
          query: "confirm_tracked_changes=1",
          header: "X-Confirm-Tracked-Changes: 1",
        });
        assert.match(String(http?.body.detail), /Nothing was downloaded or sent/);
        return true;
      },
    );
  });
  assert.equal(confirmedEvents(lines).length, 0);
});

test("tracked changes pass with the query flag and with the header", async () => {
  const bytes = await trackedOnly();
  const queryConfirmed = trackedChangesConfirmed({
    query: { confirm_tracked_changes: "1" },
    get: () => undefined,
  });
  assert.equal(queryConfirmed, true);
  const headerConfirmed = trackedChangesConfirmed({
    query: {},
    get(name: string) {
      return name.toLowerCase() === "x-confirm-tracked-changes" ? "1" : undefined;
    },
  });
  assert.equal(headerConfirmed, true);
  assert.equal(
    trackedChangesConfirmed({
      query: { confirm_tracked_changes: "0" },
      get: () => undefined,
    }),
    false,
  );
  assert.equal(
    trackedChangesConfirmed({
      query: {},
      get: () => "true",
    }),
    false,
  );

  const sentQuery = await release(bytes, queryConfirmed);
  const sentHeader = await release(bytes, headerConfirmed);
  assert.ok(sentQuery.length > 0);
  assert.ok(sentHeader.length > 0);
});

test("tracked changes plus open comments stay 422 even when confirmed", async () => {
  const bytes = await dirtyLibrary();
  const lines = await captureInfo(async () => {
    await assert.rejects(
      () => release(bytes, true, audit),
      (err: unknown) => {
        assert.ok(err instanceof OutboundOpenCommentsError);
        assert.equal(err.code, "outbound_open_comments_blocked");
        assert.equal(err.count, 2);
        assert.deepEqual(
          err.comments.map((comment) => comment.excerpt),
          [COMMENT_A, COMMENT_B],
        );
        assert.equal(err.comments.every((comment) => comment.author === "PE Test"), true);
        return true;
      },
    );
  });
  assert.equal(confirmedEvents(lines).length, 0);
});

test("attribution still blocks before comments when the confirm flag is set", async () => {
  const bytes = await attributionDirty();
  const lines = await captureInfo(async () => {
    await assert.rejects(
      () => release(bytes, true, audit),
      (err: unknown) => {
        assert.ok(err instanceof OutboundAttributionError);
        assert.equal(err.code, "outbound_attribution_blocked");
        assert.equal(err instanceof OutboundOpenCommentsError, false);
        return true;
      },
    );
    await assert.rejects(
      () =>
        bytesSafeForSignedUrl(bytes, "memo.docx", "docx", bytes, sponsorOn),
      (err: unknown) => {
        assert.ok(err instanceof OutboundAttributionError);
        assert.equal(err.code, "outbound_attribution_blocked");
        return true;
      },
    );
  });
  assert.equal(confirmedEvents(lines).length, 0);
});

test("a confirmed tracked-change release writes one audit line", async () => {
  const bytes = await trackedOnly();
  const lines = await captureInfo(() => release(bytes, true, audit));
  const events = confirmedEvents(lines);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event, "outbound_tracked_changes_confirmed_release");
  assert.equal(events[0]?.userId, "user-1");
  assert.equal(events[0]?.documentId, "doc-1");
  assert.equal(events[0]?.versionId, "ver-1");
  assert.equal(events[0]?.route, "export");
  assert.deepEqual(events[0]?.counts, trackedCounts());
  assert.match(String(events[0]?.timestamp), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("sponsor-ci off does not block comments or tracked changes and does not log", async () => {
  const dirty = await dirtyLibrary();
  const lines = await captureInfo(async () => {
    const payload = await prepareOutboundFileBytes(dirty, "memo.docx", sponsorOff);
    await gateOutboundReview(payload, "memo.docx", {
      confirmed: false,
      env: sponsorOff,
      audit,
    });
  });
  assert.equal(confirmedEvents(lines).length, 0);
});

test("paragraph-mark ins/del inside w:rPr count once as formatting", () => {
  const xml = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr>
        <w:rPr>
          <w:ins w:id="1" w:author="PE Test" w:date="2026-10-06T13:00:00Z"/>
        </w:rPr>
        <w:pPrChange w:id="2" w:author="PE Test" w:date="2026-10-06T13:00:00Z"><w:pPr/></w:pPrChange>
      </w:pPr>
      <w:r>
        <w:rPr>
          <w:rPrChange w:id="3" w:author="PE Test" w:date="2026-10-06T13:00:00Z"><w:rPr><w:b/></w:rPr></w:rPrChange>
        </w:rPr>
        <w:t>text</w:t>
      </w:r>
      ${INS}
      <w:moveFrom w:id="201" w:author="PE Test" w:date="2026-10-06T13:00:00Z"><w:r><w:t>from</w:t></w:r></w:moveFrom>
      <w:moveTo w:id="202" w:author="PE Test" w:date="2026-10-06T13:00:00Z"><w:r><w:t>to</w:t></w:r></w:moveTo>
      <mc:AlternateContent>
        <mc:Choice Requires="w14">${DEL}</mc:Choice>
        <mc:Fallback>${DEL}</mc:Fallback>
      </mc:AlternateContent>
    </w:p>
  </w:body>
</w:document>`;
  assert.deepEqual(countTrackedChanges(xml), {
    insertions: 1,
    deletions: 1,
    moveFrom: 1,
    moveTo: 1,
    formatting: 3,
  });
});

test("headers, footers, footnotes, endnotes, and comments are scanned", async () => {
  const bytes = await reviewDocx({
    body: `<w:r><w:t>Body.</w:t></w:r>`,
    extra: {
      "word/header1.xml": `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${INS}</w:p></w:hdr>`,
      "word/footer1.xml": `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:moveFrom w:id="7" w:author="PE Test" w:date="2026-10-06T13:00:00Z"><w:r><w:t>x</w:t></w:r></w:moveFrom></w:p></w:ftr>`,
      "word/footnotes.xml": `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote>${DEL}</w:footnote></w:footnotes>`,
      "word/endnotes.xml": `<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote><w:p><w:moveTo w:id="8" w:author="PE Test" w:date="2026-10-06T13:00:00Z"><w:r><w:t>y</w:t></w:r></w:moveTo></w:p></w:endnote></w:endnotes>`,
    },
  });
  const finding = await inspectDocxReviewState(bytes);
  assert.deepEqual(finding?.counts, {
    insertions: 1,
    deletions: 1,
    moveFrom: 1,
    moveTo: 1,
    formatting: 0,
    total: 4,
  });
});

test("comment excerpts are capped at 120 characters", async () => {
  const long = "A".repeat(180);
  const bytes = await reviewDocx({
    body: `<w:r><w:t>Body.</w:t></w:r>`,
    comments: [commentXml("0", "AAAA0001", long)],
  });
  const finding = await inspectDocxReviewState(bytes);
  assert.equal(finding?.comments[0]?.excerpt.length, 120);
  assert.equal(finding?.comments[0]?.excerpt, "A".repeat(120));
});

test("download-zip blocks the whole archive on any open comment and lists tracked documents", async () => {
  const commented = await commentsOnly();
  const tracked = await trackedOnly();
  const clean = await reviewDocx({ body: `<w:r><w:t>${CLEAN_TEXT}</w:t></w:r>` });
  const lines = await captureInfo(async () => {
    await assert.rejects(
      () =>
        gateOutboundZipMembers(
          [
            member("clean.docx", "doc-clean", clean),
            member("notes.docx", "doc-notes", commented),
            member("redline.docx", "doc-redline", tracked),
          ],
          { confirmed: true, userId: "user-1", route: "download-zip", env: sponsorOn },
        ),
      (err: unknown) => {
        assert.ok(err instanceof OutboundOpenCommentsError);
        assert.equal(err.count, 1);
        assert.equal(err.comments[0]?.filename, "notes.docx");
        assert.equal(err.documents?.length, 1);
        assert.equal(err.documents?.[0]?.documentId, "doc-notes");
        const http = outboundReviewHttpError(err);
        assert.equal(http?.status, 422);
        return true;
      },
    );
  });
  assert.equal(confirmedEvents(lines).length, 0);

  await assert.rejects(
    () =>
      gateOutboundZipMembers(
        [
          member("a.docx", "doc-a", tracked),
          member("b.docx", "doc-b", tracked),
          member("c.docx", "doc-c", clean),
        ],
        { confirmed: false, userId: "user-1", route: "download-zip", env: sponsorOn },
      ),
    (err: unknown) => {
      assert.ok(err instanceof OutboundTrackedChangesNeedsConfirmationError);
      const http = outboundReviewHttpError(err);
      assert.equal(http?.status, 428);
      const documents = http?.body.documents as { filename: string; counts: TrackedChangeCounts }[];
      assert.deepEqual(
        documents.map((doc) => doc.filename),
        ["a.docx", "b.docx"],
      );
      assert.equal(documents[0]?.counts.total, 2);
      assert.equal((http?.body.counts as TrackedChangeCounts).total, 4);
      return true;
    },
  );

  const released = await captureInfo(() =>
    gateOutboundZipMembers(
      [member("a.docx", "doc-a", tracked), member("c.docx", "doc-c", clean)],
      {
        confirmed: trackedChangesConfirmed({
          query: { confirm_tracked_changes: "1" },
          get: () => undefined,
        }),
        userId: "user-9",
        route: "download-zip",
        env: sponsorOn,
      },
    ),
  );
  const events = confirmedEvents(released);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.documentId, "doc-a");
  assert.equal(events[0]?.route, "download-zip");
  assert.equal(events[0]?.userId, "user-9");
});

test("outbound routes call the review gate after attribution and /display does not", () => {
  const root = path.join(__dirname, "../..");
  const documents = readFileSync(path.join(root, "routes/documents.ts"), "utf8");
  const downloads = readFileSync(path.join(root, "routes/downloads.ts"), "utf8");
  const index = readFileSync(path.join(root, "index.ts"), "utf8");
  const helper = readFileSync(path.join(root, "lib/outboundAttribution.ts"), "utf8");

  const urlStart = documents.indexOf('"/:documentId/url"');
  const docxStart = documents.indexOf('"/:documentId/docx"');
  const exportStart = documents.indexOf('"/:documentId/export"');
  assert.ok(urlStart > 0 && docxStart > urlStart && exportStart > docxStart);

  const urlFn = documents.slice(urlStart, docxStart);
  assert.match(urlFn, /bytesSafeForSignedUrl\(\s*stored,/);
  assert.ok(urlFn.indexOf("gateOutboundReview(") > urlFn.indexOf("bytesSafeForSignedUrl("));
  assert.ok(urlFn.indexOf("await getSignedUrl(") > urlFn.indexOf("gateOutboundReview("));
  assert.match(urlFn, /trackedChangesConfirmed\(req\)/);
  assert.equal(/uploadFile/.test(urlFn), false);
  assert.equal(/rewriteBannedDocxAuthors/.test(urlFn), false);

  const docxFn = documents.slice(docxStart, exportStart);
  assert.match(docxFn, /prepareLibraryDownload/);
  assert.ok(docxFn.indexOf("bytesSafeForSignedUrl") > docxFn.indexOf("prepareLibraryDownload"));
  assert.ok(docxFn.indexOf("gateOutboundReview(") > docxFn.indexOf("bytesSafeForSignedUrl"));
  assert.ok(docxFn.indexOf("res.send(payload)") > docxFn.indexOf("gateOutboundReview("));
  assert.equal(/res\.send\(raw\)/.test(docxFn), false);
  assert.match(docxFn, /trackedChangesConfirmed\(req\)/);

  const exportFn = documents.slice(
    exportStart,
    documents.indexOf("function downloadFilenameForVersion"),
  );
  assert.ok(exportFn.indexOf("gateOutboundReview(") > exportFn.indexOf("prepareOutboundFileBytes"));
  assert.ok(exportFn.indexOf("res.send(payload)") > exportFn.indexOf("gateOutboundReview("));
  assert.match(exportFn, /trackedChangesConfirmed\(req\)/);

  const zipFn = documents.slice(documents.indexOf('"/download-zip"'), urlStart);
  assert.ok(zipFn.indexOf("gateOutboundZipMembers(") > zipFn.indexOf("prepareOutboundFileBytes"));
  assert.ok(zipFn.indexOf("res.send(content)") > zipFn.indexOf("gateOutboundZipMembers("));
  assert.match(zipFn, /trackedChangesConfirmed\(req\)/);

  const displayFn = documents.slice(
    documents.indexOf('"/:documentId/display"'),
    documents.indexOf('"/download-zip"'),
  );
  assert.equal(displayFn.includes("gateOutboundReview"), false);
  assert.equal(displayFn.includes("gateOutboundZipMembers"), false);

  assert.ok(downloads.indexOf("gateOutboundReview(") > downloads.indexOf("prepareOutboundFileBytes"));
  assert.ok(downloads.indexOf("res.send(payload)") > downloads.indexOf("gateOutboundReview("));
  assert.match(downloads, /trackedChangesConfirmed\(req\)/);

  assert.match(index, /X-Confirm-Tracked-Changes/);

  const helperStart = helper.indexOf("export async function bytesSafeForSignedUrl");
  const helperEnd = helper.indexOf("function rewriteAuthorAttributes");
  const helperFn = helper.slice(helperStart, helperEnd);
  assert.ok(helperFn.indexOf("findOutboundDocxAttribution(stored)") >= 0);
  assert.ok(
    helperFn.indexOf("prepareOutboundFileBytes") >
      helperFn.indexOf("findOutboundDocxAttribution(stored)"),
  );
  assert.match(helperFn, /return stored/);
});

async function release(
  bytes: Buffer,
  confirmed: boolean,
  reviewAudit?: OutboundReviewAudit,
): Promise<Buffer> {
  const payload = await prepareOutboundFileBytes(bytes, "memo.docx", sponsorOn);
  await gateOutboundReview(payload, "memo.docx", {
    confirmed,
    env: sponsorOn,
    audit: reviewAudit ?? null,
  });
  return payload;
}

function member(filename: string, documentId: string, bytes: Buffer) {
  return {
    filename,
    documentId,
    versionId: `ver-${documentId}`,
    bytes,
  };
}

function trackedCounts(): TrackedChangeCounts {
  return {
    insertions: 1,
    deletions: 1,
    moveFrom: 0,
    moveTo: 0,
    formatting: 0,
    total: 2,
  };
}

async function captureInfo(run: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.info = original;
  }
  return lines;
}

function confirmedEvents(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (event): event is Record<string, unknown> =>
        !!event && event.event === "outbound_tracked_changes_confirmed_release",
    );
}

function commentXml(id: string, paraId: string, text: string): string {
  return `<w:comment w:id="${id}" w:author="PE Test" w:initials="PT" w:date="2026-10-06T13:00:00Z"><w:p w14:paraId="${paraId}"><w:r><w:t>${text}</w:t></w:r></w:p></w:comment>`;
}

function commentAnchor(id: string): string {
  return `<w:commentRangeStart w:id="${id}"/><w:r><w:t> </w:t></w:r><w:commentRangeEnd w:id="${id}"/><w:r><w:commentReference w:id="${id}"/></w:r>`;
}

async function commentsOnly(): Promise<Buffer> {
  return reviewDocx({
    body: `<w:r><w:t>Comments only.</w:t></w:r>${commentAnchor("0")}`,
    comments: [commentXml("0", "AAAA0001", COMMENT_A)],
  });
}

async function resolvedOnly(): Promise<Buffer> {
  return reviewDocx({
    body: `<w:r><w:t>Resolved comments.</w:t></w:r>${commentAnchor("0")}${commentAnchor("1")}`,
    comments: [
      commentXml("0", "AAAA0001", COMMENT_A),
      commentXml("1", "AAAA0002", COMMENT_B),
    ],
    extended: [
      `<w15:commentEx w15:paraId="AAAA0001" w15:done="1"/>`,
      `<w15:commentEx w15:paraId="AAAA0002" w15:done="1"/>`,
    ],
  });
}

async function trackedOnly(): Promise<Buffer> {
  return reviewDocx({
    body: `${DEL}${INS}<w:r><w:t>Tracked only.</w:t></w:r>`,
  });
}

async function dirtyLibrary(extraBody = ""): Promise<Buffer> {
  return reviewDocx({
    body: `${DEL}${INS}${commentAnchor("0")}${commentAnchor("1")}<w:r><w:t>Dirty library.</w:t></w:r>${extraBody}`,
    comments: [
      commentXml("0", "AAAA0001", COMMENT_A),
      commentXml("1", "AAAA0002", COMMENT_B),
    ],
  });
}

async function attributionDirty(): Promise<Buffer> {
  return dirtyLibrary(`<w:r><w:t>${ATTRIBUTION}</w:t></w:r>`);
}

async function reviewDocx(input: {
  body: string;
  comments?: string[];
  extended?: string[];
  extra?: Record<string, string>;
}): Promise<Buffer> {
  const hasComments = (input.comments?.length ?? 0) > 0;
  const hasExtended = (input.extended?.length ?? 0) > 0;
  const overrides = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
  ];
  const rels = [];
  if (hasComments) {
    overrides.push(
      `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>`,
    );
    rels.push(
      `<Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>`,
    );
  }
  if (hasExtended) {
    overrides.push(
      `<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>`,
    );
    rels.push(
      `<Relationship Id="rIdCommentsEx" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>`,
    );
  }
  const parts: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${overrides.join("\n  ")}
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join("\n  ")}
</Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body><w:p>${input.body}</w:p></w:body>
</w:document>`,
  };
  if (hasComments) {
    parts["word/comments.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  ${input.comments?.join("\n  ")}
</w:comments>`;
  }
  if (hasExtended) {
    parts["word/commentsExtended.xml"] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  ${input.extended?.join("\n  ")}
</w15:commentsEx>`;
  }
  Object.assign(parts, input.extra);
  return docxPackage(parts);
}

async function docxPackage(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}
