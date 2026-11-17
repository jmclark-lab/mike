import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import JSZip from "jszip";
import {
  COUNCIL_JUDGE,
  COUNCIL_MEMBERS,
  conveneCouncilWithCompleter,
  resolveCouncilJudge,
  resolveCouncilSeats,
} from "../llm/council";
import {
  chatModelsForRequest,
  completeTextStrict,
  resolveModelChain,
  streamChatWithTools,
} from "../llm/index";
import { DEFAULT_MAIN_MODEL, resolveModel } from "../llm/models";
import {
  OutboundAttributionError,
  findOutboundDocxAttribution,
  findOutboundPdfAttribution,
  bytesSafeForSignedUrl,
  prepareLibraryDownload,
  prepareOutboundFileBytes,
  rewriteBannedDocxAuthors,
} from "../outboundAttribution";
import { byteViewToArrayBuffer } from "../storage";
import {
  assertSponsorCiAllowsModel,
  fenceModelId,
  isFencedModelId,
  isSponsorCiMode,
  SPONSOR_CI_FRONTIER_MODELS,
  resolveSponsorCiMode,
  sponsorCiBootWarning,
} from "../sponsorCiMode";

const PHRASE = "Mike, an AI legal assistant";
const sponsorOn = { SPONSOR_CI_MODE: "1" } as NodeJS.ProcessEnv;

test("SPONSOR_CI_MODE accepts 1, true, yes, and on", () => {
  // NODE_ENV is unset here: non-production behavior. Unset stays off.
  for (const value of ["1", "true", "TRUE", "yes", "on"]) {
    assert.equal(isSponsorCiMode({ SPONSOR_CI_MODE: value }), true, value);
  }
  for (const value of ["", "0", "false", "off", "no"]) {
    assert.equal(isSponsorCiMode({ SPONSOR_CI_MODE: value }), false, value);
  }
  assert.equal(isSponsorCiMode({}), false);
  assert.equal(isSponsorCiMode({ NODE_ENV: "development" }), false);
  assert.equal(isSponsorCiMode({ NODE_ENV: "test", SPONSOR_CI_MODE: "0" }), false);
});

const production = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

test("production treats unset SPONSOR_CI_MODE as on", () => {
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
});

test("production explicit 1 is on", () => {
  for (const value of ["1", "true", "yes", "on", " TRUE "]) {
    const decision = resolveSponsorCiMode({
      ...production,
      SPONSOR_CI_MODE: value,
    });
    assert.equal(decision.enabled, true, value);
    assert.equal(decision.disableRefused, false, value);
  }
});

test("production explicit 0 without a change-control note refuses OFF", () => {
  for (const value of ["0", "false", "off", "no", "FALSE", " Off "]) {
    const decision = resolveSponsorCiMode({
      ...production,
      SPONSOR_CI_MODE: value,
    });
    assert.equal(decision.enabled, true, value);
    assert.equal(decision.disableRefused, true, value);
    assert.match(sponsorCiBootWarning({ ...production, SPONSOR_CI_MODE: value }) ?? "", /Refusing OFF/);
  }
  const blankNote = resolveSponsorCiMode({
    ...production,
    SPONSOR_CI_MODE: "0",
    SPONSOR_CI_CHANGE_CONTROL_NOTE: "   ",
  });
  assert.equal(blankNote.enabled, true);
  assert.equal(blankNote.disableRefused, true);
});

test("production explicit 0 with a change-control note is off", () => {
  for (const value of ["0", "false", "off", "no"]) {
    const decision = resolveSponsorCiMode({
      ...production,
      SPONSOR_CI_MODE: value,
      SPONSOR_CI_CHANGE_CONTROL_NOTE: "CoS 2026-09-23 fence paused",
    });
    assert.equal(decision.enabled, false, value);
    assert.equal(decision.disableRefused, false, value);
    assert.equal(
      sponsorCiBootWarning({
        ...production,
        SPONSOR_CI_MODE: value,
        SPONSOR_CI_CHANGE_CONTROL_NOTE: "CoS 2026-09-23 fence paused",
      }),
      null,
    );
  }
});

test("GET /healthz echoes sponsorCiMode from isSponsorCiMode and stays unauthenticated", () => {
  const src = readFileSync(path.join(__dirname, "../../index.ts"), "utf8");
  assert.match(src, /app\.get\("\/healthz"/);
  assert.match(src, /sponsorCiMode:\s*isSponsorCiMode\(\)/);
  assert.equal(/app\.get\("\/healthz"[\s\S]*requireAuth/.test(src), false);
  assert.equal(isSponsorCiMode(production), true);
  assert.equal(isSponsorCiMode({ SPONSOR_CI_MODE: "1" }), true);
});

test("checked-in templates expect production Sponsor-CI flags on", () => {
  const repoRoot = path.resolve(__dirname, "../../../..");
  const railway = readFileSync(path.join(repoRoot, "backend/railway.toml"), "utf8");
  const operations = readFileSync(path.join(repoRoot, "docs/OPERATIONS.md"), "utf8");
  const backendEnv = readFileSync(path.join(repoRoot, "backend/.env.example"), "utf8");
  const frontendEnv = readFileSync(
    path.join(repoRoot, "frontend/.env.local.example"),
    "utf8",
  );
  for (const [name, text] of [
    ["backend/railway.toml", railway],
    ["docs/OPERATIONS.md", operations],
    ["backend/.env.example", backendEnv],
  ] as const) {
    assert.match(text, /SPONSOR_CI_MODE=1/, name);
    assert.match(text, /NEXT_PUBLIC_SPONSOR_CI_MODE=1/, name);
  }
  assert.match(frontendEnv, /NEXT_PUBLIC_SPONSOR_CI_MODE=1/);
  assert.match(operations, /SPONSOR_CI_CHANGE_CONTROL_NOTE/);
  assert.match(operations, /build time/);
});

test("library signed url refuses a dirty docx and an unlabeled zip", async () => {
  const dirty = await docxPackage(dirtyDocxParts());
  for (const filename of ["memo.docx", "download"]) {
    await assert.rejects(
      () => bytesSafeForSignedUrl(dirty, filename, filename.endsWith(".docx") ? "docx" : null),
      (err: unknown) => {
        assert.ok(err instanceof OutboundAttributionError);
        assert.equal(err.code, "outbound_attribution_blocked");
        return true;
      },
    );
  }
  await assert.rejects(
    () => prepareLibraryDownload(dirty, "memo.docx", "docx"),
    (err: unknown) => {
      assert.ok(err instanceof OutboundAttributionError);
      assert.equal(err.code, "outbound_attribution_blocked");
      return true;
    },
  );
});

test("library signed url refuses a scrubbable body and the stream returns clean bytes", async () => {
  const bodyOnly = await docxPackage({
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Cover note from ${PHRASE}. Mike Smith shall review the AI vendor clause.</w:t></w:r></w:p></w:body></w:document>`,
    "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>bioaccess</dc:creator><cp:lastModifiedBy>bioaccess</cp:lastModifiedBy></cp:coreProperties>`,
  });
  await assert.rejects(
    () => bytesSafeForSignedUrl(bodyOnly, "memo", null),
    (err: unknown) => {
      assert.ok(err instanceof OutboundAttributionError);
      assert.equal(err.code, "outbound_attribution_blocked");
      return true;
    },
  );
  const streamed = await prepareLibraryDownload(bodyOnly, "memo", null);
  const xml = await (await JSZip.loadAsync(streamed)).file("word/document.xml")!.async("string");
  assert.equal(xml.includes(PHRASE), false);
  assert.match(xml, /Mike Smith shall review the AI vendor clause/);
});

test("library signed url allows a clean docx and refuses author-only dirty storage", async () => {
  const clean = await docxPackage({
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mike Smith shall review the AI vendor clause.</w:t></w:r></w:p></w:body></w:document>`,
    "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>bioaccess</dc:creator><cp:lastModifiedBy>Amavita Research</cp:lastModifiedBy></cp:coreProperties>`,
  });
  const signed = await bytesSafeForSignedUrl(clean, "memo.docx", "docx");
  assert.equal(signed.equals(clean), true);
  const streamed = await prepareLibraryDownload(clean, "memo.docx", "docx");
  const cleanXml = await (await JSZip.loadAsync(streamed)).file("word/document.xml")!.async("string");
  assert.match(cleanXml, /Mike Smith shall review the AI vendor clause/);

  const dirtyCreator = await docxPackage({
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mike Smith shall review the AI vendor clause.</w:t></w:r></w:p></w:body></w:document>`,
    "docProps/core.xml": `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${PHRASE}</dc:creator><cp:lastModifiedBy>bioaccess</cp:lastModifiedBy></cp:coreProperties>`,
  });
  const rewritten = (await rewriteBannedDocxAuthors(dirtyCreator, "bioaccess")).bytes;
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

test("library /url gates stored bytes before getSignedUrl and does not rewrite them", () => {
  const src = readFileSync(path.join(__dirname, "../../routes/documents.ts"), "utf8");
  const helper = readFileSync(path.join(__dirname, "../outboundAttribution.ts"), "utf8");
  const urlStart = src.indexOf('"/:documentId/url"');
  const docxStart = src.indexOf('"/:documentId/docx"');
  const exportStart = src.indexOf('"/:documentId/export"');
  assert.ok(urlStart > 0 && docxStart > urlStart && exportStart > docxStart);
  const urlFn = src.slice(urlStart, docxStart);
  const gateAt = urlFn.indexOf("bytesSafeForSignedUrl(");
  const signAt = urlFn.indexOf("await getSignedUrl(");
  assert.ok(gateAt >= 0 && signAt > gateAt);
  assert.match(urlFn, /bytesSafeForSignedUrl\(\s*stored,/);
  assert.equal(/uploadFile/.test(urlFn), false);
  assert.equal(/rewriteBannedDocxAuthors/.test(urlFn), false);
  assert.equal(/rewriteAndPersistBannedDocxAuthors/.test(urlFn), false);
  const helperStart = helper.indexOf("export async function bytesSafeForSignedUrl");
  const helperEnd = helper.indexOf("function rewriteAuthorAttributes");
  assert.ok(helperStart > 0 && helperEnd > helperStart);
  const helperFn = helper.slice(helperStart, helperEnd);
  const hitAt = helperFn.indexOf("findOutboundDocxAttribution(stored)");
  const scrubAt = helperFn.indexOf("prepareOutboundFileBytes");
  assert.ok(hitAt >= 0 && scrubAt > hitAt);
  assert.equal(/findOutboundDocxAttribution\(\s*rewritten/.test(helperFn), false);
  assert.equal(/prepareOutboundFileBytes\(\s*rewritten/.test(helperFn), false);
  assert.match(helperFn, /return stored/);
  const docxFn = src.slice(docxStart, exportStart);
  assert.match(docxFn, /prepareLibraryDownload/);
  assert.ok(docxFn.indexOf("bytesSafeForSignedUrl") > docxFn.indexOf("prepareLibraryDownload"));
  assert.ok(docxFn.indexOf("bytesSafeForSignedUrl") < docxFn.indexOf("res.send(payload)"));
  assert.equal(/res\.send\(raw\)/.test(docxFn), false);
});

test("smoke dirty fixture blocks signed URL even after author rewrite", async () => {
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
  await assert.rejects(
    () =>
      prepareLibraryDownload(
        dirty,
        "smoke-dirty-mike-ai-attribution.docx",
        "docx",
        sponsorOn,
      ),
    (err: unknown) => {
      assert.ok(err instanceof OutboundAttributionError);
      assert.equal(err.code, "outbound_attribution_blocked");
      return true;
    },
  );

  const streamed = await prepareLibraryDownload(
    rewritten,
    "smoke-dirty-mike-ai-attribution.docx",
    "docx",
    sponsorOn,
  );
  assert.equal(streamed.includes(Buffer.from(PHRASE)), false);
  const streamedHits = await findOutboundDocxAttribution(streamed);
  assert.deepEqual(streamedHits, []);
  await bytesSafeForSignedUrl(
    streamed,
    "smoke-dirty-mike-ai-attribution.docx",
    "docx",
    streamed,
    sponsorOn,
  );

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
        exact,
        sponsorOn,
      ),
    (err: unknown) => {
      assert.ok(err instanceof OutboundAttributionError);
      assert.equal(err.code, "outbound_attribution_blocked");
      return true;
    },
  );
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
  assert.equal(isFencedModelId("claude-fable-5-2"), false);
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
  assert.equal(DEFAULT_MAIN_MODEL, "gemini-4-carbon");
});

test("Sponsor-CI frontier allowlist includes Fable 5.2 and keeps 5.1", () => {
  assert.equal(SPONSOR_CI_FRONTIER_MODELS.includes("claude-fable-5-2"), true);
  assert.equal(SPONSOR_CI_FRONTIER_MODELS.includes("claude-fable-5-1"), true);
  assert.equal(SPONSOR_CI_FRONTIER_MODELS.includes("claude-fable-5"), true);
});

const pinnedKimiReady = {
  ...sponsorOn,
  KIMI_K31_PRO_ENABLED: "true",
  MOONSHOT_API_KEY: "test-moonshot-key",
} as NodeJS.ProcessEnv;

test("Sponsor-CI allows only an explicit kimi-k3.1-pro pin when the flag is exactly true and a key is set", () => {
  assert.doesNotThrow(() =>
    assertSponsorCiAllowsModel("kimi-k3.1-pro", pinnedKimiReady),
  );
  assert.doesNotThrow(() =>
    assertSponsorCiAllowsModel(" Kimi-K3.1-Pro ", {
      ...pinnedKimiReady,
      KIMI_K31_PRO_ENABLED: " true ",
    }),
  );
  assert.equal(isFencedModelId("kimi-k3.1-pro"), true);
  assert.equal(
    resolveModel("kimi-k3.1-pro", DEFAULT_MAIN_MODEL, pinnedKimiReady),
    DEFAULT_MAIN_MODEL,
  );
  assert.equal(
    fenceModelId("kimi-k3.1-pro", DEFAULT_MAIN_MODEL, pinnedKimiReady),
    DEFAULT_MAIN_MODEL,
  );
  assert.deepEqual(resolveModelChain(pinnedKimiReady), [
    "gemini-4-carbon",
    "grok-4.7",
    "nvidia/nemotron-3-ultra-550b-a55b",
  ]);
  assert.deepEqual(
    resolveModelChain({
      ...pinnedKimiReady,
      LLM_MODEL: "kimi-k3.1-pro",
      LLM_FALLBACK_MODEL: "kimi-k3.1-pro,deepseek-v4-pro",
    }),
    ["gemini-4-carbon", "grok-4.7", "nvidia/nemotron-3-ultra-550b-a55b"],
  );
  const pinned = chatModelsForRequest({
    strictModel: true,
    model: "kimi-k3.1-pro",
    env: pinnedKimiReady,
  });
  assert.equal(pinned.strict, true);
  assert.deepEqual(pinned.models, ["kimi-k3.1-pro"]);
  const unpinned = chatModelsForRequest({
    strictModel: false,
    model: "kimi-k3.1-pro",
    env: pinnedKimiReady,
  });
  assert.equal(unpinned.strict, false);
  assert.deepEqual(unpinned.models, [
    "gemini-4-carbon",
    "grok-4.7",
    "nvidia/nemotron-3-ultra-550b-a55b",
  ]);
});

test("Sponsor-CI still refuses the Kimi pin when the flag is off or the key is missing", () => {
  for (const env of [
    sponsorOn,
    { ...sponsorOn, KIMI_K31_PRO_ENABLED: "true" },
    { ...sponsorOn, KIMI_K31_PRO_ENABLED: "1", MOONSHOT_API_KEY: "test-moonshot-key" },
    { ...sponsorOn, KIMI_K31_PRO_ENABLED: "yes", MOONSHOT_API_KEY: "test-moonshot-key" },
    { ...sponsorOn, KIMI_K31_PRO_ENABLED: "on", MOONSHOT_API_KEY: "test-moonshot-key" },
    { ...sponsorOn, KIMI_K31_PRO_ENABLED: "TRUE", MOONSHOT_API_KEY: "test-moonshot-key" },
    { ...sponsorOn, KIMI_K31_PRO_ENABLED: "true", MOONSHOT_API_KEY: "   " },
  ] as NodeJS.ProcessEnv[]) {
    assert.throws(
      () => assertSponsorCiAllowsModel("kimi-k3.1-pro", env),
      /Sponsor-CI mode refuses kimi-k3\.1-pro/,
    );
  }
});

test("Sponsor-CI still refuses other Kimi ids, DeepSeek, and Sakana when the Kimi pin is ready", () => {
  for (const id of [
    "kimi-k3.1-pro-highspeed",
    "kimi-k2.5",
    "deepseek-v4-pro",
    "fugu-ultra-20260615",
  ]) {
    assert.throws(
      () => assertSponsorCiAllowsModel(id, pinnedKimiReady),
      new RegExp(`Sponsor-CI mode refuses ${id}`),
    );
  }
});

test("Sponsor-CI keeps Kimi off the council and the judge when the pin is ready", () => {
  const env = {
    ...pinnedKimiReady,
    COUNCIL_ANTHROPIC_MODEL: "kimi-k3.1-pro",
    COUNCIL_OPENAI_MODEL: "kimi-k2.5",
    COUNCIL_GEMINI_MODEL: "kimi-k3.1-pro",
    COUNCIL_GEMINI_LABEL: "Kimi",
    COUNCIL_XAI_MODEL: "deepseek-v4-pro",
    COUNCIL_JUDGE: "kimi-k3.1-pro",
  } as NodeJS.ProcessEnv;
  assert.deepEqual(
    resolveCouncilSeats(env).map((seat) => seat.model),
    [...COUNCIL_MEMBERS],
  );
  assert.equal(resolveCouncilJudge(env), COUNCIL_JUDGE);
  assert.equal(
    resolveCouncilSeats(env).some((seat) => seat.model.startsWith("kimi-")),
    false,
  );
});

test("Sponsor-CI unpinned chat chain is Gemini, Grok, and Nemotron", () => {
  assert.deepEqual(
    resolveModelChain({
      ...sponsorOn,
      LLM_MODEL: "deepseek-v4-pro",
      LLM_FALLBACK_MODEL: "fugu-ultra-20260615,claude-sonnet-4-6",
    }),
    ["gemini-4-carbon", "grok-4.7", "nvidia/nemotron-3-ultra-550b-a55b"],
  );
  const withGrok = resolveModelChain({
    ...sponsorOn,
    LLM_MODEL: "grok-4.7",
  });
  assert.equal(withGrok[0], "grok-4.7");
  assert.equal(withGrok.includes("gemini-4-carbon"), true);
  assert.equal(withGrok.includes("nvidia/nemotron-3-ultra-550b-a55b"), true);
  assert.equal(withGrok.some((id) => id.startsWith("claude") || id.startsWith("gpt-")), false);
  assert.equal(
    withGrok.some((id) => id.startsWith("deepseek-") || id.startsWith("fugu-")),
    false,
  );
  const explicitClaude = resolveModelChain({
    ...sponsorOn,
    LLM_MODEL: "claude-fable-5-2",
    LLM_FALLBACK_MODEL: "claude-opus-5-5,gpt-6-astra",
  });
  assert.deepEqual(explicitClaude.slice(0, 3), [
    "claude-fable-5-2",
    "claude-opus-5-5",
    "gpt-6-astra",
  ]);
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
  assert.equal(seats[2].label, "Gemini 4 Carbon");
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

test("a strict chat pin of kimi-k3.1-pro runs under Sponsor-CI only when the flag and key are set", async () => {
  const previous = {
    sponsor: process.env.SPONSOR_CI_MODE,
    kimi: process.env.KIMI_K31_PRO_ENABLED,
    key: process.env.MOONSHOT_API_KEY,
    serp: process.env.SERP_SEARCH_MODE,
    router: process.env.SEARCH_ROUTER_MODE,
  };
  const originalFetch = globalThis.fetch;
  let requestedModels: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { model?: string };
    requestedModels.push(body.model ?? "");
    const encoder = new TextEncoder();
    const payload = [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hidden indemnity thought" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "The clause is mutual." }, finish_reason: "stop" }] })}\n\n`,
    ].join("");
    return new Response(encoder.encode(payload), { status: 200 });
  };
  process.env.SERP_SEARCH_MODE = "off";
  process.env.SEARCH_ROUTER_MODE = "off";
  try {
    process.env.SPONSOR_CI_MODE = "1";
    delete process.env.KIMI_K31_PRO_ENABLED;
    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    await assert.rejects(
      () =>
        streamChatWithTools({
          model: "kimi-k3.1-pro",
          strictModel: true,
          systemPrompt: "Answer.",
          messages: [{ role: "user", content: "Review the clause." }],
        }),
      /Sponsor-CI mode refuses kimi-k3\.1-pro/,
    );
    assert.deepEqual(requestedModels, []);

    process.env.KIMI_K31_PRO_ENABLED = "true";
    delete process.env.MOONSHOT_API_KEY;
    await assert.rejects(
      () =>
        streamChatWithTools({
          model: "kimi-k3.1-pro",
          strictModel: true,
          systemPrompt: "Answer.",
          messages: [{ role: "user", content: "Review the clause." }],
        }),
      /Sponsor-CI mode refuses kimi-k3\.1-pro/,
    );
    assert.deepEqual(requestedModels, []);

    process.env.MOONSHOT_API_KEY = "test-moonshot-key";
    await assert.rejects(
      () =>
        streamChatWithTools({
          model: "kimi-k3.1-pro-highspeed",
          strictModel: true,
          systemPrompt: "Answer.",
          messages: [{ role: "user", content: "Review the clause." }],
        }),
      /Sponsor-CI mode refuses kimi-k3\.1-pro-highspeed/,
    );
    const result = await streamChatWithTools({
      model: "kimi-k3.1-pro",
      strictModel: true,
      systemPrompt: "Answer.",
      messages: [{ role: "user", content: "Review the clause." }],
    });
    assert.deepEqual(requestedModels, ["kimi-k3.1-pro"]);
    assert.equal(result.fullText, "The clause is mutual.");
    assert.equal(result.fullText.includes("hidden indemnity"), false);
    assert.equal(result.providerMetadata?.model_name, "kimi-k3.1-pro");
    assert.deepEqual(result.providerMetadata?.attempted_models, ["kimi-k3.1-pro"]);
    assert.equal(result.providerMetadata?.fallback_depth, 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ["SPONSOR_CI_MODE", previous.sponsor],
      ["KIMI_K31_PRO_ENABLED", previous.kimi],
      ["MOONSHOT_API_KEY", previous.key],
      ["SERP_SEARCH_MODE", previous.serp],
      ["SEARCH_ROUTER_MODE", previous.router],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("Sponsor-CI replaces an injected Kimi council seat and judge even when the pin is ready", async () => {
  const previous = {
    sponsor: process.env.SPONSOR_CI_MODE,
    kimi: process.env.KIMI_K31_PRO_ENABLED,
    key: process.env.MOONSHOT_API_KEY,
    judge: process.env.COUNCIL_JUDGE,
  };
  process.env.SPONSOR_CI_MODE = "1";
  process.env.KIMI_K31_PRO_ENABLED = "true";
  process.env.MOONSHOT_API_KEY = "test-moonshot-key";
  process.env.COUNCIL_JUDGE = "kimi-k3.1-pro";
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
            model: "kimi-k3.1-pro",
            label: "Kimi",
            maxTokens: 1000,
          },
          {
            provider: "openai",
            model: "kimi-k2.5",
            label: "Kimi other",
            maxTokens: 1000,
          },
          {
            provider: "google",
            model: "deepseek-v4-pro",
            label: "DeepSeek",
            maxTokens: 1000,
          },
          {
            provider: "xai",
            model: "fugu-ultra-20260615",
            label: "Fugu",
            maxTokens: 1000,
          },
        ],
      },
    );
  } finally {
    for (const [name, value] of [
      ["SPONSOR_CI_MODE", previous.sponsor],
      ["KIMI_K31_PRO_ENABLED", previous.kimi],
      ["MOONSHOT_API_KEY", previous.key],
      ["COUNCIL_JUDGE", previous.judge],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.deepEqual(invoked.slice(0, 4).sort(), [...COUNCIL_MEMBERS].sort());
  assert.equal(invoked.at(-1), COUNCIL_JUDGE);
  assert.equal(invoked.some((id) => id.startsWith("kimi-")), false);
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
