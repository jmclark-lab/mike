import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import JSZip from "jszip";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createFileReadStream: vi.fn(),
    downloadFile: vi.fn(),
    ensureDocAccess: vi.fn(),
    getSignedUrl: vi.fn(),
    headFile: vi.fn(),
    loadActiveVersion: vi.fn(),
    uploadFile: vi.fn(),
}));

const database = {
    from: vi.fn(() => {
        const query: Record<string, unknown> = {};
        for (const method of ["select", "eq"]) {
            query[method] = vi.fn(() => query);
        }
        query.single = vi.fn(async () => ({
            data: {
                id: "document-1",
                user_id: "user-1",
                project_id: null,
                org_id: null,
                workflow_id: null,
            },
            error: null,
        }));
        return query;
    }),
};

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "user-1";
        res.locals.userEmail = "user@example.com";
        next();
    },
}));

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => database),
}));

vi.mock("../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/access")>()),
    ensureDocAccess: mocks.ensureDocAccess,
}));

vi.mock("../../lib/documentVersions", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/documentVersions")>()),
    loadActiveVersion: mocks.loadActiveVersion,
}));

vi.mock("../../lib/storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/storage")>()),
    createFileReadStream: mocks.createFileReadStream,
    downloadFile: mocks.downloadFile,
    getSignedUrl: mocks.getSignedUrl,
    headFile: mocks.headFile,
    uploadFile: mocks.uploadFile,
}));

import { documentsRouter } from "../../modules/documents/documents.routes";

const app = express();
app.use(express.json());
app.use("/single-documents", documentsRouter);

const DIRTY = readFileSync(
    path.join(
        __dirname,
        "../../lib/__tests__/fixtures/smoke-dirty-mike-ai-attribution.docx",
    ),
);

function asArrayBuffer(bytes: Buffer): ArrayBuffer {
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
}

async function cleanDocx(): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Mike Smith shall review the AI vendor clause.</w:t></w:r></w:p></w:body></w:document>`,
    );
    zip.file(
        "docProps/core.xml",
        `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>bioaccess</dc:creator><cp:lastModifiedBy>Amavita Research</cp:lastModifiedBy></cp:coreProperties>`,
    );
    return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

function version(fileType: string, filename: string) {
    return {
        id: "version-2",
        storage_path: "documents/user-1/document-1/source",
        pdf_storage_path: null,
        version_number: 2,
        filename,
        source: "user_upload",
        file_type: fileType,
        size_bytes: 3,
        page_count: null,
    };
}

describe("Library download attribution gate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
        mocks.getSignedUrl.mockResolvedValue("https://signed.example/object");
        mocks.headFile.mockResolvedValue({
            size: 3,
            etag: '"etag"',
            contentType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
    });

    it("returns 422 and does not mint a signed URL for the dirty fixture", async () => {
        mocks.loadActiveVersion.mockResolvedValue(
            version("docx", "smoke-dirty-mike-ai-attribution.docx"),
        );
        mocks.downloadFile.mockResolvedValue(asArrayBuffer(DIRTY));

        const response = await request(app)
            .get("/single-documents/document-1/url")
            .set("Authorization", "Bearer test");

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("outbound_attribution_blocked");
        expect(response.body.detail).toMatch(/Export blocked/);
        expect(response.body.hits.length).toBeGreaterThan(0);
        expect(JSON.stringify(response.body)).not.toMatch(/https?:\/\//);
        expect(mocks.getSignedUrl).not.toHaveBeenCalled();
        expect(mocks.uploadFile).not.toHaveBeenCalled();
    });

    it("mints a signed URL for a clean docx", async () => {
        const clean = await cleanDocx();
        mocks.loadActiveVersion.mockResolvedValue(version("docx", "memo.docx"));
        mocks.downloadFile.mockResolvedValue(asArrayBuffer(clean));

        const response = await request(app)
            .get("/single-documents/document-1/url?version_id=version-2")
            .set("Authorization", "Bearer test");

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            url: "https://signed.example/object",
            document_id: "document-1",
            filename: "memo.docx",
            version_id: "version-2",
        });
        expect(mocks.downloadFile).toHaveBeenCalledWith(
            "documents/user-1/document-1/source",
        );
        expect(mocks.getSignedUrl).toHaveBeenCalledTimes(1);
        expect(mocks.getSignedUrl).toHaveBeenCalledWith(
            "documents/user-1/document-1/source",
            3600,
            "memo.docx",
        );
        expect(mocks.uploadFile).not.toHaveBeenCalled();
    });

    it("does not sign when the stored object is missing", async () => {
        mocks.loadActiveVersion.mockResolvedValue(version("docx", "memo.docx"));
        mocks.downloadFile.mockResolvedValue(null);

        const response = await request(app).get(
            "/single-documents/document-1/url",
        );

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ detail: "No file available" });
        expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    });

    it("blocks the /file stream for a dirty docx and does not open storage again", async () => {
        mocks.loadActiveVersion.mockResolvedValue(
            version("docx", "smoke-dirty-mike-ai-attribution.docx"),
        );
        mocks.downloadFile.mockResolvedValue(asArrayBuffer(DIRTY));

        const response = await request(app).get(
            "/single-documents/document-1/file",
        );

        expect(response.status).toBe(422);
        expect(response.body.code).toBe("outbound_attribution_blocked");
        expect(mocks.createFileReadStream).not.toHaveBeenCalled();
        expect(mocks.getSignedUrl).not.toHaveBeenCalled();
    });

    it("sends the verified clean docx bytes on /file", async () => {
        const clean = await cleanDocx();
        mocks.loadActiveVersion.mockResolvedValue(version("docx", "memo.docx"));
        mocks.downloadFile.mockResolvedValue(asArrayBuffer(clean));

        const response = await request(app)
            .get("/single-documents/document-1/file")
            .buffer(true)
            .parse((res, callback) => {
                const chunks: Buffer[] = [];
                res.on("data", (chunk: Buffer | string) => {
                    chunks.push(Buffer.from(chunk));
                });
                res.on("end", () => callback(null, Buffer.concat(chunks)));
            });

        expect(response.status).toBe(200);
        expect(response.headers["content-type"]).toMatch(/wordprocessingml/);
        expect(Buffer.isBuffer(response.body)).toBe(true);
        expect((response.body as Buffer).equals(clean)).toBe(true);
        expect(mocks.createFileReadStream).not.toHaveBeenCalled();
    });
});
