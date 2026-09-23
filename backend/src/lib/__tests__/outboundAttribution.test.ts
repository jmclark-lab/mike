import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, test } from "vitest";
import { byteViewToArrayBuffer } from "../storage";
import {
    NEUTRAL_TRACKED_CHANGE_AUTHOR,
    OUTBOUND_ATTRIBUTION_PHRASES,
    OUTBOUND_ATTRIBUTION_RULE,
    OutboundAttributionError,
    assertOutboundPlainText,
    bytesSafeForSignedUrl,
    findOutboundDocxAttribution,
    findOutboundPdfAttribution,
    isSafeCompanyAuthor,
    prepareLibraryDownload,
    prepareOutboundDocxBytes,
    prepareOutboundFileBytes,
    rejectedOrganisationDetail,
    resolveTrackedChangeAuthor,
    rewriteAndPersistBannedDocxAuthors,
    rewriteBannedDocxAuthors,
    scrubOutboundAttribution,
    scrubOutboundDocxBytes,
    trackedChangeAuthorForUser,
} from "../outboundAttribution";
import {
    assertSponsorCiAllowsModel,
    fenceModelId,
    isFencedModelId,
    isSponsorCiFrontierModel,
    isSponsorCiFencedModel,
    isSponsorCiMode,
    resolveSponsorCiMode,
    sponsorCiBootWarning,
} from "../sponsorCiMode";

const PHRASE = "Mike, an AI legal assistant";
const sponsorOn = { SPONSOR_CI_MODE: "1" } as NodeJS.ProcessEnv;
const production = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
const originalEnv = process.env.TRACKED_CHANGE_AUTHOR;

afterEach(() => {
    if (originalEnv === undefined) delete process.env.TRACKED_CHANGE_AUTHOR;
    else process.env.TRACKED_CHANGE_AUTHOR = originalEnv;
});

async function docxPackage(parts: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
    if (!parts["word/document.xml"]) {
        zip.file(
            "word/document.xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello.</w:t></w:r></w:p></w:body></w:document>`,
        );
    }
    return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

function dirtyDocxParts(): Record<string, string> {
    return {
        "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:ins w:id="1" w:author="${PHRASE}">
        <w:r><w:t>Mike Smith shall review the AI vendor clause. This draft is from ${PHRASE}.</w:t></w:r>
      </w:ins>
    </w:p>
  </w:body>
</w:document>`,
        "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="${PHRASE}"><w:p><w:r><w:t>Comment from ${PHRASE}.</w:t></w:r></w:p></w:comment></w:comments>`,
        "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${PHRASE}</dc:creator><cp:lastModifiedBy>${PHRASE}</cp:lastModifiedBy></cp:coreProperties>`,
    };
}

function minimalPdf(text: string, creator: string): Buffer {
    const escaped = text.replace(/[()\\]/g, "\\$&");
    const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
    const objects = [
        "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
        "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
        "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
        `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`,
        "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
        `6 0 obj << /Creator (${creator.replace(/[()\\]/g, "\\$&")}) /Author (Amavita Research) >> endobj\n`,
    ];
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (const object of objects) {
        offsets.push(body.length);
        body += object;
    }
    const xrefAt = body.length;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
        xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    body += xref;
    body += `trailer << /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
    return Buffer.from(body, "latin1");
}

test("SPONSOR_CI_MODE is opt-in outside production and fail-closed in production", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) {
        assert.equal(isSponsorCiMode({ SPONSOR_CI_MODE: value }), true, value);
    }
    for (const value of ["", "0", "false", "off", "no"]) {
        assert.equal(isSponsorCiMode({ SPONSOR_CI_MODE: value }), false, value);
    }
    assert.equal(isSponsorCiMode({}), false);
    assert.equal(isSponsorCiMode({ NODE_ENV: "development" }), false);
    assert.equal(
        isSponsorCiMode({ NODE_ENV: "test", SPONSOR_CI_MODE: "0" }),
        false,
    );

    for (const env of [
        production,
        { ...production, SPONSOR_CI_MODE: "" },
        { ...production, SPONSOR_CI_MODE: "   " },
        { ...production, SPONSOR_CI_MODE: "maybe" },
    ]) {
        const decision = resolveSponsorCiMode(env);
        assert.equal(decision.enabled, true);
        assert.equal(decision.disableRefused, false);
        assert.equal(sponsorCiBootWarning(env), null);
    }

    for (const value of ["0", "false", "off", "no", "FALSE", " Off "]) {
        const decision = resolveSponsorCiMode({
            ...production,
            SPONSOR_CI_MODE: value,
        });
        assert.equal(decision.enabled, true, value);
        assert.equal(decision.disableRefused, true, value);
        assert.match(
            sponsorCiBootWarning({ ...production, SPONSOR_CI_MODE: value }) ??
                "",
            /Refusing OFF/,
        );
    }
    const blankNote = resolveSponsorCiMode({
        ...production,
        SPONSOR_CI_MODE: "0",
        SPONSOR_CI_CHANGE_CONTROL_NOTE: "   ",
    });
    assert.equal(blankNote.enabled, true);
    assert.equal(blankNote.disableRefused, true);

    const noted = resolveSponsorCiMode({
        ...production,
        SPONSOR_CI_MODE: "0",
        SPONSOR_CI_CHANGE_CONTROL_NOTE: "CoS 2026-09-23 fence paused",
    });
    assert.equal(noted.enabled, false);
    assert.equal(noted.disableRefused, false);
    assert.equal(
        sponsorCiBootWarning({
            ...production,
            SPONSOR_CI_MODE: "0",
            SPONSOR_CI_CHANGE_CONTROL_NOTE: "CoS 2026-09-23 fence paused",
        }),
        null,
    );
});

test("sponsor model helpers fence Sakana and DeepSeek only while the mode is on", () => {
    assert.equal(isFencedModelId("deepseek-v4-pro"), true);
    assert.equal(isFencedModelId(" Fugu-ultra "), true);
    assert.equal(isFencedModelId("claude-fable-5-1"), false);
    assert.equal(isSponsorCiFencedModel("deepseek-v4-pro", sponsorOn), true);
    assert.equal(isSponsorCiFencedModel("deepseek-v4-pro", {}), false);
    assert.equal(isSponsorCiFrontierModel("claude-opus-5-5"), true);
    assert.equal(isSponsorCiFrontierModel("deepseek-v4-pro"), false);
    assert.equal(
        fenceModelId("deepseek-v4-pro", "claude-fable-5-1", sponsorOn),
        "claude-fable-5-1",
    );
    assert.equal(
        fenceModelId("claude-opus-5-5", "fallback", sponsorOn),
        "claude-opus-5-5",
    );
    assert.equal(fenceModelId("  ", "fallback", sponsorOn), "fallback");
    assert.equal(fenceModelId("deepseek-v4-pro", "fallback", {}), "deepseek-v4-pro");
    assert.throws(
        () => assertSponsorCiAllowsModel("deepseek-v4-pro", sponsorOn),
        /Sponsor-CI mode refuses deepseek-v4-pro/,
    );
    assert.doesNotThrow(() =>
        assertSponsorCiAllowsModel("claude-fable-5-1", sponsorOn),
    );
});

test("GET /healthz echoes sponsorCiMode and the download gate runs before getSignedUrl", () => {
    const appSrc = readFileSync(path.join(__dirname, "../../app.ts"), "utf8");
    const healthzStart = appSrc.indexOf('app.get("/healthz"');
    assert.ok(healthzStart > 0);
    const healthzFn = appSrc.slice(healthzStart, healthzStart + 800);
    assert.match(healthzFn, /sponsorCiMode:\s*isSponsorCiMode\(\)/);
    assert.match(healthzFn, /commit:/);
    assert.equal(/requireAuth/.test(healthzFn), false);
    assert.equal(isSponsorCiMode(production), true);

    const downloadSrc = readFileSync(
        path.join(__dirname, "../../modules/documents/documents.download.ts"),
        "utf8",
    );
    const urlStart = downloadSrc.indexOf("export async function getDownloadUrl");
    const fileStart = downloadSrc.indexOf(
        "export async function getFileStreamSource",
    );
    assert.ok(urlStart > 0 && fileStart > urlStart);
    const urlFn = downloadSrc.slice(urlStart, fileStart);
    const gateAt = urlFn.indexOf("await gateExactStoredBytes(");
    const signAt = urlFn.indexOf("await getSignedUrl(");
    assert.ok(gateAt >= 0 && signAt > gateAt);
    assert.equal(/uploadFile/.test(urlFn), false);
    assert.equal(/rewriteBannedDocxAuthors/.test(urlFn), false);
    assert.equal(/rewriteAndPersistBannedDocxAuthors/.test(urlFn), false);
    const fileFn = downloadSrc.slice(fileStart);
    assert.match(fileFn, /gateExactStoredBytes/);
    assert.equal(/rewriteBannedDocxAuthors/.test(fileFn), false);

    const helper = readFileSync(
        path.join(__dirname, "../outboundAttribution.ts"),
        "utf8",
    );
    const helperStart = helper.indexOf(
        "export async function bytesSafeForSignedUrl",
    );
    const helperEnd = helper.indexOf("function rewriteAuthorAttributes");
    const helperFn = helper.slice(helperStart, helperEnd);
    const hitAt = helperFn.indexOf("findOutboundDocxAttribution(stored)");
    const scrubAt = helperFn.indexOf("prepareOutboundFileBytes");
    assert.ok(hitAt >= 0 && scrubAt > hitAt);
    assert.match(helperFn, /return stored/);
    assert.equal(/uploadFile/.test(helperFn), false);

    const routes = readFileSync(
        path.join(__dirname, "../../modules/documents/documents.routes.ts"),
        "utf8",
    );
    assert.match(routes, /"kind" in result/);
    assert.match(routes, /res\.status\(422\)/);
    assert.match(routes, /result\.kind === "attribution"/);
    assert.equal(/app\.get\("\/healthz"/.test(routes), false);
});

test("tracked-change author prefers organisation, then env, then Author", async () => {
    process.env.TRACKED_CHANGE_AUTHOR = "Amavita Research";
    assert.equal(
        resolveTrackedChangeAuthor({ organisation: "bioaccess" }),
        "bioaccess",
    );
    assert.equal(
        resolveTrackedChangeAuthor({ organisation: "  Amavita Sciences™  " }),
        "Amavita Sciences™",
    );
    assert.equal(
        resolveTrackedChangeAuthor({ organisation: null }),
        "Amavita Research",
    );
    assert.equal(
        resolveTrackedChangeAuthor({ organisation: "Mike" }),
        "Amavita Research",
    );
    process.env.TRACKED_CHANGE_AUTHOR = "Legal AI";
    assert.equal(
        resolveTrackedChangeAuthor({ organisation: "Mike" }),
        NEUTRAL_TRACKED_CHANGE_AUTHOR,
    );
    delete process.env.TRACKED_CHANGE_AUTHOR;
    assert.equal(
        resolveTrackedChangeAuthor({ organisation: "   " }),
        NEUTRAL_TRACKED_CHANGE_AUTHOR,
    );
    assert.equal(isSafeCompanyAuthor("Mike"), false);
    assert.equal(isSafeCompanyAuthor("Amavita Research"), true);
    assert.equal(
        resolveTrackedChangeAuthor({ organisation: null, envAuthor: null }),
        NEUTRAL_TRACKED_CHANGE_AUTHOR,
    );

    const db = (organisation: string | null, error: { message: string } | null = null) => ({
        from(table: string) {
            assert.equal(table, "user_profiles");
            return {
                select() {
                    return {
                        eq() {
                            return {
                                maybeSingle: async () => ({
                                    data: organisation
                                        ? { organisation }
                                        : { organisation: null },
                                    error,
                                }),
                            };
                        },
                    };
                },
            };
        },
    });
    process.env.TRACKED_CHANGE_AUTHOR = "Fallback Co";
    assert.equal(
        await trackedChangeAuthorForUser(db("bioaccess"), "user-1"),
        "bioaccess",
    );
    assert.equal(
        await trackedChangeAuthorForUser(db("Mike"), "user-1"),
        "Fallback Co",
    );
    assert.equal(
        await trackedChangeAuthorForUser(db(null, { message: "nope" }), "user-1"),
        "Fallback Co",
    );
    assert.equal(
        await trackedChangeAuthorForUser(
            { from() { throw new Error("db down"); } },
            "user-1",
        ),
        "Fallback Co",
    );
});

test("scrub removes disclosure phrases and leaves ordinary Mike Smith prose", async () => {
    const leaked =
        "This cover memo was prepared with the assistance of Mike, an AI legal assistant.";
    const scrubbed = scrubOutboundAttribution(leaked);
    assert.equal(
        /mike|ai legal assistant|prepared with the assistance/i.test(scrubbed),
        false,
    );
    assert.equal(
        scrubOutboundAttribution("The schedule was generated by AI."),
        "The schedule was.",
    );
    const ordinary =
        "Mike Smith shall review the AI vendor clause. Michael is not a tool.";
    assert.equal(scrubOutboundAttribution(ordinary), ordinary);
    for (const phrase of OUTBOUND_ATTRIBUTION_PHRASES) {
        const hit = scrubOutboundAttribution(`Note: ${phrase}.`);
        assert.equal(hit.toLowerCase().includes(phrase), false, phrase);
    }
    assert.match(OUTBOUND_ATTRIBUTION_RULE, /every organisation and tenant/);

    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Prepared with the assistance of Mike, an AI legal assistant.</w:t></w:r></w:p>
    <w:p><w:ins w:id="1" w:author="Mike Smith"><w:r><w:t>Site shall maintain insurance.</w:t></w:r></w:ins></w:p>
  </w:body>
</w:document>`,
    );
    const input = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const output = await scrubOutboundDocxBytes(input);
    const documentXml = await (await JSZip.loadAsync(output))
        .file("word/document.xml")!
        .async("string");
    assert.equal(/ai legal assistant/i.test(documentXml), false);
    assert.match(documentXml, /w:author="Mike Smith"/);
    assert.equal(
        (await scrubOutboundDocxBytes(Buffer.from("not-a-zip"))).equals(
            Buffer.from("not-a-zip"),
        ),
        true,
    );
});

test("export gate fails closed on split disclosures and banned authors", async () => {
    const split = await docxPackage({
        "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>This memo was prepared with the </w:t></w:r>
      <w:r><w:t>assistance of Mike.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>`,
    });
    await assert.rejects(
        () => prepareOutboundDocxBytes(split),
        (err: unknown) => {
            assert.ok(err instanceof OutboundAttributionError);
            assert.equal(err.code, "outbound_attribution_blocked");
            return true;
        },
    );

    const footnote = await docxPackage({
        "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Site shall maintain insurance.</w:t></w:r></w:p></w:body></w:document>`,
        "word/footnotes.xml": `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote><w:p><w:r><w:t>See the legal assistant note.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    });
    await assert.rejects(
        () => prepareOutboundDocxBytes(footnote),
        OutboundAttributionError,
    );

    const bytes = await docxPackage(dirtyDocxParts());
    await assert.rejects(
        () => prepareOutboundFileBytes(bytes, "memo.docx", {}),
        OutboundAttributionError,
    );
    const rewritten = await rewriteBannedDocxAuthors(bytes, "bioaccess");
    assert.ok(rewritten.rewritten >= 4);
    const sent = await prepareOutboundDocxBytes(rewritten.bytes);
    assert.deepEqual(await findOutboundDocxAttribution(sent), []);
    const banned = await rewriteBannedDocxAuthors(bytes, "Mike");
    const bannedXml = await (await JSZip.loadAsync(banned.bytes))
        .file("word/document.xml")!
        .async("string");
    assert.match(bannedXml, /w:author="Author"/);
    assert.equal(/w:author="Mike"/.test(bannedXml), false);

    let persisted: Buffer | null = null;
    const stored = await rewriteAndPersistBannedDocxAuthors(
        bytes,
        "bioaccess",
        async (next) => {
            persisted = next;
        },
    );
    assert.ok(persisted);
    assert.equal(stored.equals(persisted!), true);
    const unchanged = await rewriteAndPersistBannedDocxAuthors(
        sent,
        "bioaccess",
        async () => {
            throw new Error("clean bytes must not be uploaded");
        },
    );
    assert.equal(unchanged.equals(sent), true);
});

test("plain text, legacy doc, and other payloads follow sponsor mode", async () => {
    assert.throws(
        () =>
            assertOutboundPlainText(
                "Cover note prepared-with the model and assisted-by Mike.",
                "email body",
            ),
        OutboundAttributionError,
    );
    assert.doesNotThrow(() =>
        assertOutboundPlainText(
            "Mike Smith shall review the AI vendor clause.",
            "email body",
        ),
    );
    assert.match(rejectedOrganisationDetail("Mike") ?? "", /cannot be Mike/);
    assert.match(
        rejectedOrganisationDetail("x".repeat(121)) ?? "",
        /120 characters/,
    );
    assert.match(rejectedOrganisationDetail("line\nbreak") ?? "", /line breaks/);
    assert.equal(rejectedOrganisationDetail("bioaccess"), null);
    assert.equal(rejectedOrganisationDetail("   "), null);

    const dirtyText = Buffer.from(`Please send this. ${PHRASE}.`, "utf8");
    await assert.rejects(
        () => prepareOutboundFileBytes(dirtyText, "note.txt", sponsorOn),
        (err: unknown) => {
            assert.ok(err instanceof OutboundAttributionError);
            assert.equal(err.code, "outbound_attribution_blocked");
            return true;
        },
    );
    const cleanText = Buffer.from(
        "Mike Smith shall review the AI vendor clause.",
        "utf8",
    );
    assert.equal(
        (await prepareOutboundFileBytes(cleanText, "note.txt", sponsorOn)).equals(
            cleanText,
        ),
        true,
    );
    assert.equal(
        (await prepareOutboundFileBytes(dirtyText, "note.txt", {})).equals(
            dirtyText,
        ),
        true,
    );
    await assert.rejects(
        () => prepareOutboundFileBytes(dirtyText, "legacy.doc", {}),
        OutboundAttributionError,
    );
    await assert.rejects(
        () => prepareOutboundFileBytes(dirtyText, "blob.bin", sponsorOn),
        OutboundAttributionError,
    );
    assert.equal(
        (await prepareOutboundFileBytes(dirtyText, "blob.bin", {})).equals(
            dirtyText,
        ),
        true,
    );
});

test("library signed url refuses dirty docx bytes and allows a clean package", async () => {
    const dirty = await docxPackage(dirtyDocxParts());
    for (const filename of ["memo.docx", "download"]) {
        await assert.rejects(
            () =>
                bytesSafeForSignedUrl(
                    dirty,
                    filename,
                    filename.endsWith(".docx") ? "docx" : null,
                ),
            (err: unknown) => {
                assert.ok(err instanceof OutboundAttributionError);
                assert.equal(err.code, "outbound_attribution_blocked");
                return true;
            },
        );
    }
    const clean = await docxPackage({
        "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mike Smith shall review the AI vendor clause.</w:t></w:r></w:p></w:body></w:document>`,
        "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>bioaccess</dc:creator><cp:lastModifiedBy>Amavita Research</cp:lastModifiedBy></cp:coreProperties>`,
    });
    const signed = await bytesSafeForSignedUrl(clean, "memo.docx", "docx");
    assert.equal(signed.equals(clean), true);

    const dirtyCreator = await docxPackage({
        "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mike Smith shall review the AI vendor clause.</w:t></w:r></w:p></w:body></w:document>`,
        "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${PHRASE}</dc:creator><cp:lastModifiedBy>bioaccess</cp:lastModifiedBy></cp:coreProperties>`,
    });
    const rewritten = (await rewriteBannedDocxAuthors(dirtyCreator, "bioaccess"))
        .bytes;
    assert.equal(rewritten.equals(dirtyCreator), false);
    await assert.rejects(
        () => bytesSafeForSignedUrl(dirtyCreator, "memo.docx", "docx", rewritten),
        (err: unknown) => {
            assert.ok(err instanceof OutboundAttributionError);
            assert.equal(err.code, "outbound_attribution_blocked");
            return true;
        },
    );
});

test("smoke dirty fixture blocks a signed URL and keeps dc:creator as a hit", async () => {
    const dirty = readFileSync(
        path.join(__dirname, "fixtures/smoke-dirty-mike-ai-attribution.docx"),
    );
    assert.equal(dirty.subarray(0, 2).toString("latin1"), "PK");
    const hits = await findOutboundDocxAttribution(dirty);
    assert.equal(
        hits.some((hit) => hit.match.toLowerCase() === PHRASE.toLowerCase()),
        true,
    );
    assert.equal(
        hits.some((hit) => hit.location.includes("dc:creator")),
        true,
    );
    assert.equal(
        hits.some((hit) => hit.location.includes("cp:lastModifiedBy")),
        true,
    );

    const rewritten = (await rewriteBannedDocxAuthors(dirty, "bioaccess")).bytes;
    assert.equal(rewritten.equals(dirty), false);
    for (const candidate of [dirty, rewritten]) {
        await assert.rejects(
            () =>
                bytesSafeForSignedUrl(
                    dirty,
                    "smoke-dirty-mike-ai-attribution.docx",
                    "docx",
                    candidate,
                    sponsorOn,
                ),
            (err: unknown) => {
                assert.ok(err instanceof OutboundAttributionError);
                assert.equal(err.code, "outbound_attribution_blocked");
                return true;
            },
        );
    }

    const streamed = await prepareLibraryDownload(
        rewritten,
        "smoke-dirty-mike-ai-attribution.docx",
        "docx",
        sponsorOn,
    );
    assert.equal(streamed.includes(Buffer.from(PHRASE)), false);
    assert.deepEqual(await findOutboundDocxAttribution(streamed), []);
    const signedClean = await bytesSafeForSignedUrl(
        streamed,
        "smoke-dirty-mike-ai-attribution.docx",
        "docx",
        streamed,
        sponsorOn,
    );
    assert.equal(signedClean.equals(streamed), true);

    const pool = new Uint8Array(dirty.length + 64);
    pool.fill(0x41);
    pool.set(dirty, 32);
    const view = pool.subarray(32, 32 + dirty.length);
    const exact = Buffer.from(byteViewToArrayBuffer(view));
    assert.equal(exact.equals(dirty), true);
    assert.equal(Buffer.from(view.buffer).equals(dirty), false);
    await assert.rejects(
        () =>
            bytesSafeForSignedUrl(
                exact,
                "smoke-dirty-mike-ai-attribution.docx",
                "docx",
            ),
        OutboundAttributionError,
    );
});

test("pdf export gate reads body text and creator metadata", async () => {
    const leaked = minimalPdf(
        "This memo was prepared with the assistance of Mike.",
        "Amavita Research",
    );
    const leakedHits = await findOutboundPdfAttribution(leaked);
    assert.equal(
        leakedHits.some((hit) =>
            /prepared with the assistance of mike/i.test(hit.match),
        ),
        true,
    );
    await assert.rejects(
        () => prepareOutboundFileBytes(leaked, "memo.pdf"),
        OutboundAttributionError,
    );

    const authored = minimalPdf("Site shall maintain insurance.", "Mike");
    const authorHits = await findOutboundPdfAttribution(authored);
    assert.equal(
        authorHits.some(
            (hit) => hit.location === "pdf Creator" && hit.match === "Mike",
        ),
        true,
    );

    const clean = minimalPdf(
        "Mike Smith shall review the AI vendor clause.",
        "Amavita Research",
    );
    assert.deepEqual(await findOutboundPdfAttribution(clean), []);
    assert.equal(
        (await prepareOutboundFileBytes(clean, "memo.pdf", sponsorOn)).equals(
            clean,
        ),
        true,
    );
    const unreadable = Buffer.from("%PDF-1.4 not a real pdf");
    const blocked = await findOutboundPdfAttribution(unreadable);
    assert.equal(blocked[0]?.location, "pdf");
    await assert.rejects(
        () => bytesSafeForSignedUrl(unreadable, "scan.pdf", "pdf"),
        OutboundAttributionError,
    );
});
