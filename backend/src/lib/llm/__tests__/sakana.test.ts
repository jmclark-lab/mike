import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Minimal mocks — set up before importing the module under test
// ---------------------------------------------------------------------------

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

// Helper: build a minimal streaming response from an array of SSE data lines
function makeSseResponse(lines: string[]): Response {
    const body = lines.map((l) => `data: ${l}\n\n`).join("") + "data: [DONE]\n\n";
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(body));
            controller.close();
        },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// Helper: build a non-streaming (JSON) response
function makeJsonResponse(json: unknown): Response {
    return new Response(JSON.stringify(json), {
        status: 200,
        headers: { "Content-Type": "application/json" },
    });
}

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import { streamSakana, completeSakanaText } from "../sakana";
import { DEFAULT_SAKANA_MODEL } from "../models";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamSakana", () => {
    const apiKey = "test-key-abc";
    const baseEnv = { SAKANA_API_KEY: apiKey };

    beforeEach(() => {
        vi.resetAllMocks();
        for (const [k, v] of Object.entries(baseEnv)) process.env[k] = v;
    });

    afterEach(() => {
        delete process.env.SAKANA_API_KEY;
        delete process.env.SAKANA_MODEL;
        delete process.env.SAKANA_BASE_URL;
    });

    it("uses DEFAULT_SAKANA_MODEL as fallback model", async () => {
        const chunk = JSON.stringify({
            id: "resp-1",
            choices: [{ delta: { content: "hello" }, finish_reason: "stop" }],
        });
        fetchMock.mockResolvedValueOnce(makeSseResponse([chunk]));

        await streamSakana({
            model: DEFAULT_SAKANA_MODEL,
            systemPrompt: "sys",
            messages: [{ role: "user", content: "hi" }],
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body.model).toBe(DEFAULT_SAKANA_MODEL);
    });

    it("SAKANA_MODEL env var overrides requested model", async () => {
        process.env.SAKANA_MODEL = "fugu-mini-test";
        const chunk = JSON.stringify({
            id: "resp-2",
            choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
        });
        fetchMock.mockResolvedValueOnce(makeSseResponse([chunk]));

        await streamSakana({
            model: DEFAULT_SAKANA_MODEL,
            systemPrompt: "sys",
            messages: [{ role: "user", content: "hi" }],
        });

        const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
        expect(body.model).toBe("fugu-mini-test");
    });

    it("returns providerMetadata with provider_name === sakana_fugu", async () => {
        const chunk = JSON.stringify({
            id: "resp-3",
            choices: [{ delta: { content: "world" }, finish_reason: "stop" }],
        });
        fetchMock.mockResolvedValueOnce(makeSseResponse([chunk]));

        const result = await streamSakana({
            model: DEFAULT_SAKANA_MODEL,
            systemPrompt: "sys",
            messages: [{ role: "user", content: "hi" }],
        });

        expect(result.providerMetadata?.provider_name).toBe("sakana_fugu");
        expect(result.providerMetadata?.model_name).toBe(DEFAULT_SAKANA_MODEL);
        expect(result.providerMetadata?.provider_response_id).toBe("resp-3");
    });

    it("accumulates SSE content deltas into fullText", async () => {
        const chunks = [
            JSON.stringify({ id: "r", choices: [{ delta: { content: "Hello" }, finish_reason: null }] }),
            JSON.stringify({ id: "r", choices: [{ delta: { content: ", " }, finish_reason: null }] }),
            JSON.stringify({ id: "r", choices: [{ delta: { content: "world!" }, finish_reason: "stop" }] }),
        ];
        fetchMock.mockResolvedValueOnce(makeSseResponse(chunks));

        const result = await streamSakana({
            model: DEFAULT_SAKANA_MODEL,
            systemPrompt: "sys",
            messages: [{ role: "user", content: "hi" }],
        });

        expect(result.fullText).toBe("Hello, world!");
    });

    it("throws when SAKANA_API_KEY is missing", async () => {
        delete process.env.SAKANA_API_KEY;

        await expect(
            streamSakana({
                model: DEFAULT_SAKANA_MODEL,
                systemPrompt: "sys",
                messages: [{ role: "user", content: "hi" }],
            }),
        ).rejects.toThrow(/SAKANA_API_KEY/);
    });

    it("throws on 401 response", async () => {
        fetchMock.mockResolvedValueOnce(
            new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
        );

        await expect(
            streamSakana({
                model: DEFAULT_SAKANA_MODEL,
                systemPrompt: "sys",
                messages: [{ role: "user", content: "hi" }],
            }),
        ).rejects.toThrow(/401/);
    });

    it("all fugu- model IDs route through streamSakana (providerMetadata is set)", async () => {
        const chunk = JSON.stringify({
            id: "resp-x",
            choices: [{ delta: { content: "resp" }, finish_reason: "stop" }],
        });
        fetchMock.mockResolvedValueOnce(makeSseResponse([chunk]));

        const result = await streamSakana({
            model: "fugu-ultra-20260615",
            systemPrompt: "sys",
            messages: [{ role: "user", content: "hi" }],
        });

        expect(result.providerMetadata?.provider_name).toBe("sakana_fugu");
    });
});

describe("completeSakanaText", () => {
    const apiKey = "test-key-abc";

    beforeEach(() => {
        vi.resetAllMocks();
        process.env.SAKANA_API_KEY = apiKey;
    });

    afterEach(() => {
        delete process.env.SAKANA_API_KEY;
        delete process.env.SAKANA_MODEL;
    });

    it("returns the assistant message content", async () => {
        fetchMock.mockResolvedValueOnce(
            makeJsonResponse({
                choices: [{ message: { content: "The answer is 42." } }],
            }),
        );

        const text = await completeSakanaText({
            model: DEFAULT_SAKANA_MODEL,
            user: "What is 6 * 7?",
        });

        expect(text).toBe("The answer is 42.");
    });

    it("throws when SAKANA_API_KEY is missing", async () => {
        delete process.env.SAKANA_API_KEY;

        await expect(
            completeSakanaText({ model: DEFAULT_SAKANA_MODEL, user: "hello" }),
        ).rejects.toThrow(/SAKANA_API_KEY/);
    });
});
