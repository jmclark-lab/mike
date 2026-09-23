import assert from "node:assert/strict";
import { describe, test } from "node:test";
import JSZip from "jszip";
import {
  COUNCIL_JUDGE,
  COUNCIL_MEMBERS,
  conveneCouncilWithCompleter,
  resolveCouncilJudge,
  resolveCouncilSeats,
} from "../llm/council";
import { completeTextStrict, resolveModelChain } from "../llm/index";
import { DEFAULT_MAIN_MODEL, resolveModel } from "../llm/models";
import {
  OutboundAttributionError,
  findOutboundDocxAttribution,
  findOutboundPdfAttribution,
  prepareOutboundFileBytes,
  rewriteBannedDocxAuthors,
} from "../outboundAttribution";
import {
  assertSponsorCiAllowsModel,
  isFencedModelId,
  isSponsorCiMode,
} from "../sponsorCiMode";

const PHRASE = "Mike, an AI legal assistant";
const sponsorOn = { SPONSOR_CI_MODE: "1" } as NodeJS.ProcessEnv;

test("SPONSOR_CI_MODE accepts 1, true, yes, and on", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(isSponsorCiMode({ SPONSOR_CI_MODE: value }), true, value);
  }
  for (const value of ["", "0", "false", "off", "no"]) {
    assert.equal(isSponsorCiMode({ SPONSOR_CI_MODE: value }), false, value);
  }
  assert.equal(isSponsorCiMode({}), false);
});

test("Sponsor-CI fences Sakana and DeepSeek ids even when a key is present", () => {
  const env = {
    SPONSOR_CI_MODE: "1",
    DEEPSEEK_API_KEY: "present",
    SAKANA_API_KEY: "present",
  } as NodeJS.ProcessEnv;
  assert.equal(isFencedModelId("deepseek-v4-pro"), true);
  assert.equal(isFencedModelId("fugu-ultra-20260615"), true);
  assert.equal(isFencedModelId("claude-fable-5-1"), false);
  assert.throws(
    () => assertSponsorCiAllowsModel("deepseek-v4-pro", env),
    /Sponsor-CI mode refuses deepseek-v4-pro/,
  );
  assert.throws(
    () => assertSponsorCiAllowsModel("fugu-ultra-20260615", env),
    /Sponsor-CI mode refuses fugu-ultra-20260615/,
  );
  assert.doesNotThrow(() =>
    assertSponsorCiAllowsModel("deepseek-v4-flash", {
      DEEPSEEK_API_KEY: "present",
      SPONSOR_CI_MODE: "0",
    }),
  );
  assert.equal(
    resolveModel("deepseek-v4-pro", DEFAULT_MAIN_MODEL, {}),
    "deepseek-v4-pro",
  );
  assert.equal(
    resolveModel("deepseek-v4-pro", DEFAULT_MAIN_MODEL, env),
    DEFAULT_MAIN_MODEL,
  );
  assert.equal(
    resolveModel("claude-sonnet-4-6", DEFAULT_MAIN_MODEL, env),
    "claude-sonnet-4-6",
  );
  assert.equal(DEFAULT_MAIN_MODEL, "claude-fable-5-1");
});

test("Sponsor-CI chat chain stays on Fable, Opus 5.5, and Astra", () => {
  assert.deepEqual(
    resolveModelChain({
      ...sponsorOn,
      LLM_MODEL: "deepseek-v4-pro",
      LLM_FALLBACK_MODEL: "fugu-ultra-20260615,claude-sonnet-4-6",
    }),
    ["claude-fable-5-1", "claude-opus-5-5", "gpt-6-astra"],
  );
  const withGrok = resolveModelChain({
    ...sponsorOn,
    LLM_MODEL: "grok-4.7",
  });
  assert.equal(withGrok[0], "grok-4.7");
  assert.equal(withGrok.includes("claude-fable-5-1"), true);
  assert.equal(withGrok.includes("claude-opus-5-5"), true);
  assert.equal(withGrok.includes("gpt-6-astra"), true);
  assert.equal(
    withGrok.some((id) => id.startsWith("deepseek-") || id.startsWith("fugu-")),
    false,
  );
});

test("Sponsor-CI locks council seats and the judge to the frontier GA ids", () => {
  const env = {
    ...sponsorOn,
    COUNCIL_ANTHROPIC_MODEL: "deepseek-v4-pro",
    COUNCIL_OPENAI_MODEL: "fugu-ultra-20260615",
    COUNCIL_GEMINI_MODEL: "gemini-3.5-flash",
    COUNCIL_GEMINI_LABEL: "Not Pro",
    COUNCIL_XAI_MODEL: "grok-other",
    COUNCIL_JUDGE: "deepseek-v4-flash",
    SAKANA_API_KEY: "present",
    DEEPSEEK_API_KEY: "present",
  } as NodeJS.ProcessEnv;
  const seats = resolveCouncilSeats(env);
  assert.deepEqual(
    seats.map((seat) => seat.model),
    [...COUNCIL_MEMBERS],
  );
  assert.equal(seats[2].label, "Gemini 3.1 Pro Preview");
  assert.equal(resolveCouncilJudge(env), COUNCIL_JUDGE);
  assert.equal(COUNCIL_JUDGE, "claude-opus-5-5");
  assert.equal(
    resolveCouncilSeats({ COUNCIL_XAI_MODEL: "grok-custom" })[3]?.model,
    "grok-custom",
  );
});

describe("Sponsor-CI process env", { concurrency: false }, () => {
test("Sponsor-CI ignores injected Sakana and DeepSeek council seats", async () => {
  const previous = process.env.SPONSOR_CI_MODE;
  process.env.SPONSOR_CI_MODE = "1";
  const invoked: string[] = [];
  try {
    await conveneCouncilWithCompleter(
      { question: "Review this matter." },
      async ({ model }) => {
        invoked.push(model);
        return model === COUNCIL_JUDGE ? "Judge answer" : `Answer from ${model}`;
      },
      {
        retryBaseDelayMs: 0,
        sleepFn: async () => undefined,
        seats: [
          {
            provider: "anthropic",
            model: "deepseek-v4-pro",
            label: "DeepSeek",
            maxTokens: 1000,
          },
          {
            provider: "openai",
            model: "fugu-ultra-20260615",
            label: "Fugu",
            maxTokens: 1000,
          },
          {
            provider: "google",
            model: "gemini-3.1-pro-preview",
            label: "Gemini",
            maxTokens: 1000,
          },
          {
            provider: "xai",
            model: "grok-4.7",
            label: "Grok",
            maxTokens: 1000,
          },
        ],
      },
    );
  } finally {
    if (previous === undefined) delete process.env.SPONSOR_CI_MODE;
    else process.env.SPONSOR_CI_MODE = previous;
  }
  assert.deepEqual(
    invoked.slice(0, 4).sort(),
    [...COUNCIL_MEMBERS].sort(),
  );
  assert.equal(invoked.at(-1), "claude-opus-5-5");
  assert.equal(
    invoked.some((id) => id.startsWith("deepseek-") || id.startsWith("fugu-")),
    false,
  );
});

test("strict completion refuses DeepSeek before any provider call when Sponsor-CI is on", async () => {
  const previousMode = process.env.SPONSOR_CI_MODE;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.SPONSOR_CI_MODE = "1";
  process.env.DEEPSEEK_API_KEY = "present";
  try {
    await assert.rejects(
      () => completeTextStrict({ model: "deepseek-v4-pro", user: "hello" }),
      /Sponsor-CI mode refuses deepseek-v4-pro/,
    );
    await assert.rejects(
      () =>
        completeTextStrict({
          model: "fugu-ultra-20260615",
          user: "hello",
        }),
      /Sakana Fugu is not available/,
    );
  } finally {
    if (previousMode === undefined) delete process.env.SPONSOR_CI_MODE;
    else process.env.SPONSOR_CI_MODE = previousMode;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
});
});

async function docxPackage(parts: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, xml] of Object.entries(parts)) zip.file(name, xml);
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

test("export gate rejects a docx that attributes work to Mike, an AI legal assistant", async () => {
  const dirty = await docxPackage(dirtyDocxParts());
  const hits = await findOutboundDocxAttribution(dirty);
  const locations = hits.map((hit) => hit.location).join("\n");
  assert.match(locations, /word\/document\.xml/);
  assert.match(locations, /word\/comments\.xml/);
  assert.match(locations, /w:author/);
  assert.match(locations, /docProps\/core\.xml dc:creator/);
  assert.match(locations, /docProps\/core\.xml cp:lastModifiedBy/);
  assert.equal(
    hits.some((hit) => hit.match.toLowerCase() === PHRASE.toLowerCase()),
    true,
  );

  await assert.rejects(
    () => prepareOutboundFileBytes(dirty, "memo.docx", sponsorOn),
    (err: unknown) => {
      assert.ok(err instanceof OutboundAttributionError);
      assert.equal(err.code, "outbound_attribution_blocked");
      assert.match(err.message, /Export blocked/);
      return true;
    },
  );

  const off = {} as NodeJS.ProcessEnv;
  await assert.rejects(
    () => prepareOutboundFileBytes(dirty, "memo.docx", off),
    (err: unknown) => {
      assert.ok(err instanceof OutboundAttributionError);
      assert.equal(err.code, "outbound_attribution_blocked");
      return true;
    },
  );
});

test("a cleaned docx passes the export gate and keeps Mike Smith", async () => {
  const dirty = await docxPackage(dirtyDocxParts());
  const rewritten = await rewriteBannedDocxAuthors(dirty, "bioaccess");
  assert.ok(rewritten.rewritten >= 4);
  const sent = await prepareOutboundFileBytes(rewritten.bytes, "memo.docx", sponsorOn);
  const hits = await findOutboundDocxAttribution(sent);
  assert.deepEqual(hits, []);
  const zip = await JSZip.loadAsync(sent);
  const documentXml = await zip.file("word/document.xml")!.async("string");
  const commentsXml = await zip.file("word/comments.xml")!.async("string");
  const coreXml = await zip.file("docProps/core.xml")!.async("string");
  assert.equal(new RegExp(PHRASE, "i").test(documentXml), false);
  assert.equal(new RegExp(PHRASE, "i").test(commentsXml), false);
  assert.equal(new RegExp(PHRASE, "i").test(coreXml), false);
  assert.match(documentXml, /w:author="bioaccess"/);
  assert.match(documentXml, /Mike Smith shall review the AI vendor clause/);
  assert.match(coreXml, /<dc:creator>bioaccess<\/dc:creator>/);
  assert.match(coreXml, /<cp:lastModifiedBy>bioaccess<\/cp:lastModifiedBy>/);

  const clean = await docxPackage({
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mike Smith shall review the AI vendor clause.</w:t></w:r></w:p></w:body></w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="1" w:author="bioaccess"><w:p><w:r><w:t>Keep the indemnity.</w:t></w:r></w:p></w:comment></w:comments>`,
    "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>bioaccess</dc:creator><cp:lastModifiedBy>Amavita Research</cp:lastModifiedBy></cp:coreProperties>`,
  });
  const cleanSent = await prepareOutboundFileBytes(clean, "clean.docx", sponsorOn);
  assert.deepEqual(await findOutboundDocxAttribution(cleanSent), []);
});

test("a disclosure split across Word runs still fails closed until the text is cleaned", async () => {
  const split = await docxPackage({
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Note: Mike, an </w:t></w:r><w:r><w:t>AI legal </w:t></w:r><w:r><w:t>assistant reviewed it.</w:t></w:r></w:p></w:body></w:document>`,
  });
  await assert.rejects(
    () => prepareOutboundFileBytes(split, "split.docx", sponsorOn),
    OutboundAttributionError,
  );
  const cleaned = await docxPackage({
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mike Smith shall review the AI vendor clause.</w:t></w:r></w:p></w:body></w:document>`,
  });
  const sent = await prepareOutboundFileBytes(cleaned, "split.docx", sponsorOn);
  assert.ok(sent.length > 0);
});

function minimalPdf(text: string, creator: string): Buffer {
  const escaped = text.replace(/[()\\]/g, "\\$&");
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n",
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n",
    `6 0 obj << /Creator (${creator.replace(/[()\\]/g, "\\$&")}) >> endobj\n`,
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

test("Sponsor-CI export gate rejects a dirty PDF and plain text, and passes clean copies", async () => {
  const dirtyPdf = minimalPdf(
    `Cover note from ${PHRASE}.`,
    "bioaccess",
  );
  const pdfHits = await findOutboundPdfAttribution(dirtyPdf);
  assert.equal(
    pdfHits.some((hit) => hit.match.toLowerCase() === PHRASE.toLowerCase()),
    true,
  );
  await assert.rejects(
    () => prepareOutboundFileBytes(dirtyPdf, "memo.pdf", sponsorOn),
    (err: unknown) => {
      assert.ok(err instanceof OutboundAttributionError);
      assert.equal(err.code, "outbound_attribution_blocked");
      return true;
    },
  );
  const cleanPdf = minimalPdf(
    "Mike Smith shall review the AI vendor clause.",
    "bioaccess",
  );
  const cleanPdfBytes = await prepareOutboundFileBytes(cleanPdf, "memo.pdf", sponsorOn);
  assert.equal(cleanPdfBytes.equals(cleanPdf), true);

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
  const sentText = await prepareOutboundFileBytes(cleanText, "note.txt", sponsorOn);
  assert.equal(sentText.equals(cleanText), true);

  // Mode off: plain text still passes through. The Word/PDF gate above does not.
  const bypass = await prepareOutboundFileBytes(dirtyText, "note.txt", {});
  assert.equal(bypass.equals(dirtyText), true);
});
