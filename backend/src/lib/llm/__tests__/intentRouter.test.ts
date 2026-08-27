import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
    DEFAULT_ROUTE_MODEL,
    HIGH_ROUTE_MODEL,
    buildRoutedChain,
    classifyIntent,
    firstModelForBucket,
} from "../intentRouter";
import { DEFAULT_SAKANA_MODEL } from "../models";

const origSakana = process.env.SAKANA_MODEL;

afterEach(() => {
    if (origSakana === undefined) delete process.env.SAKANA_MODEL;
    else process.env.SAKANA_MODEL = origSakana;
});

test("high-stakes signed-document tools start on Opus", () => {
    assert.equal(classifyIntent({ requestedTools: ["draft_redlines"] }).bucket, "high");
    assert.equal(
        classifyIntent({ requestedTools: ["review_against_playbook"] }).bucket,
        "high",
    );
    assert.equal(classifyIntent({ requestedTools: ["draft_contract"] }).bucket, "high");
    assert.equal(firstModelForBucket("high"), HIGH_ROUTE_MODEL);
    assert.equal(HIGH_ROUTE_MODEL, "claude-opus-4-8");
});

test("high-stakes paste-into-contract messages start on Opus", () => {
    assert.equal(
        classifyIntent({
            userText: "Generate ready-to-paste redlines for this MSA against our playbook",
        }).bucket,
        "high",
    );
    assert.equal(
        classifyIntent({ userText: "Review this NDA against the Standard Mutual NDA playbook" })
            .bucket,
        "high",
    );
    assert.equal(
        classifyIntent({ userText: "Draft a CDA for the Medtronic feasibility study" }).bucket,
        "high",
    );
    assert.equal(
        classifyIntent({
            userText:
                "Write the novel LATAM regulatory pathway so we can put it in a signed CTA",
        }).bucket,
        "high",
    );
});

test("cheap grounded lookup / ingest / obligations stay on Fugu Ultra", () => {
    assert.equal(
        classifyIntent({ requestedTools: ["search_knowledge"] }).bucket,
        "cheap",
    );
    assert.equal(classifyIntent({ requestedTools: ["ingest_document"] }).bucket, "cheap");
    assert.equal(classifyIntent({ requestedTools: ["list_obligations"] }).bucket, "cheap");
    assert.equal(
        classifyIntent({
            userText: "What does this resolution say about ethics committee composition?",
        }).bucket,
        "cheap",
    );
    assert.equal(
        classifyIntent({ userText: "Search the knowledge base for our standard indemnification cap" })
            .bucket,
        "cheap",
    );
    assert.equal(
        classifyIntent({ userText: "Ingest this contract into the knowledge base" }).bucket,
        "cheap",
    );
    assert.equal(firstModelForBucket("cheap"), DEFAULT_SAKANA_MODEL);
    assert.equal(DEFAULT_ROUTE_MODEL, "fugu-ultra-20260615");
});

test("default / unsure stays on Fugu Ultra and does not escalate", () => {
    const unclear = classifyIntent({
        userText: "Is this indemnification clause enforceable in Colombia?",
    });
    assert.equal(unclear.bucket, "default");
    assert.equal(unclear.reason, "unsure_stay_on_fugu");
    assert.equal(firstModelForBucket("default"), DEFAULT_SAKANA_MODEL);

    assert.equal(classifyIntent({ userText: "hello" }).bucket, "default");
    assert.equal(classifyIntent({}).bucket, "default");
    // General LATAM research is not signed-document work.
    assert.equal(
        classifyIntent({
            userText: "What is the INVIMA pathway for importing a Class II device?",
        }).bucket,
        "default",
    );
});

test("mixed high + cheap signal stays high (signed-document work wins)", () => {
    assert.equal(
        classifyIntent({
            userText: "Search the knowledge base then draft a CDA we can send for signature",
        }).bucket,
        "high",
    );
    assert.equal(
        classifyIntent({
            requestedTools: ["search_knowledge", "draft_redlines"],
        }).bucket,
        "high",
    );
});

test("convene_council is not a first-model escalation", () => {
    assert.equal(
        classifyIntent({ requestedTools: ["convene_council"] }).bucket,
        "default",
    );
});

test("routed chain keeps Fugu first for default and cheap, Opus first for high", () => {
    const pool = [
        "fugu-ultra-20260615",
        "claude-fable-5",
        "claude-opus-4-8",
        "gpt-5.6-sol",
    ];
    const cheap = buildRoutedChain({ bucket: "cheap", fallbackPool: pool });
    assert.equal(cheap.firstModel, "fugu-ultra-20260615");
    assert.deepEqual(cheap.chain[0], "fugu-ultra-20260615");
    assert.ok(cheap.chain.includes("claude-opus-4-8"));

    const def = buildRoutedChain({ bucket: "default", fallbackPool: pool });
    assert.equal(def.firstModel, "fugu-ultra-20260615");
    assert.equal(def.chain[0], "fugu-ultra-20260615");

    const high = buildRoutedChain({ bucket: "high", fallbackPool: pool });
    assert.equal(high.firstModel, "claude-opus-4-8");
    assert.equal(high.chain[0], "claude-opus-4-8");
    assert.deepEqual(high.chain.slice(1), [
        "fugu-ultra-20260615",
        "claude-fable-5",
        "gpt-5.6-sol",
    ]);
});
