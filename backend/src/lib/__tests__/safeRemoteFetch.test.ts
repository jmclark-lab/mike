import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  fetchRemoteDocument,
  isBlockedRemoteAddress,
  RemoteDocumentError,
  validateRemoteDocumentUrl,
} from "../safeRemoteFetch";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("blocks local, private, metadata, and non-HTTP document URLs", async () => {
  for (const url of [
    "http://127.0.0.1/admin",
    "http://10.0.0.4/file",
    "http://[::1]/file",
    "http://metadata.google.internal/computeMetadata/v1/",
    "file:///etc/passwd",
  ]) {
    await assert.rejects(validateRemoteDocumentUrl(url), RemoteDocumentError);
  }
  assert.equal(isBlockedRemoteAddress("169.254.169.254"), true);
  assert.equal(isBlockedRemoteAddress("8.8.8.8"), false);
});

test("revalidates every redirect destination", async () => {
  const fetchImpl = async () => new Response(null, {
    status: 302,
    headers: { location: "http://127.0.0.1/secrets" },
  });
  await assert.rejects(
    fetchRemoteDocument("https://93.184.216.34/document", { maxRedirects: 1, fetchImpl }),
    /blocked network address/,
  );
});

test("enforces the streamed byte limit even without Content-Length", async () => {
  const fetchImpl = async () => new Response(new Uint8Array(12));
  await assert.rejects(
    fetchRemoteDocument("https://93.184.216.34/document", { maxBytes: 10, fetchImpl }),
    (error: unknown) => error instanceof RemoteDocumentError && error.statusCode === 413,
  );
});

test("returns a bounded public document", async () => {
  const fetchImpl = async () => new Response("legal text", {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
  const result = await fetchRemoteDocument("https://93.184.216.34/document", { maxBytes: 100, fetchImpl });
  assert.equal(result.buffer.toString(), "legal text");
  assert.equal(result.contentType, "text/plain");
});
