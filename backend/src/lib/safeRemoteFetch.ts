import dns from "node:dns/promises";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.internal.",
  "instance-data",
]);

export const DEFAULT_REMOTE_DOCUMENT_LIMIT = 25 * 1024 * 1024;

export class RemoteDocumentError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
  ) {
    super(message);
    this.name = "RemoteDocumentError";
  }
}

function privateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (normalized === "::" || normalized === "::1") return true;
  if (/^(fc|fd)/.test(normalized) || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff")) return true;
  if (normalized.startsWith("2001:db8:")) return true;
  const dottedTail = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return dottedTail ? privateIpv4(dottedTail) : false;
}

export function isBlockedRemoteAddress(address: string): boolean {
  const family = net.isIP(address.replace(/^\[|\]$/g, ""));
  if (family === 4) return privateIpv4(address);
  if (family === 6) return privateIpv6(address);
  return true;
}

interface ResolvedRemoteUrl {
  url: URL;
  address: string;
  family: 4 | 6;
}

async function resolveRemoteDocumentUrl(rawUrl: string): Promise<ResolvedRemoteUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new RemoteDocumentError("Document URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RemoteDocumentError("Document URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new RemoteDocumentError("Document URL must not contain credentials.");
  }
  url.hash = "";
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || BLOCKED_HOSTS.has(hostname)) {
    throw new RemoteDocumentError("Document URL points to a blocked host.");
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new RemoteDocumentError("Document host could not be resolved.");
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedRemoteAddress(address))) {
    throw new RemoteDocumentError("Document URL resolves to a blocked network address.");
  }
  const selected = addresses[0];
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

export async function validateRemoteDocumentUrl(rawUrl: string): Promise<URL> {
  return (await resolveRemoteDocumentUrl(rawUrl)).url;
}

export interface SafeRemoteDocument {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
}

export interface SafeRemoteFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Test-only transport injection; production uses a DNS-pinned Undici agent. */
  fetchImpl?: typeof fetch;
}

export async function fetchRemoteDocument(
  rawUrl: string,
  options: SafeRemoteFetchOptions = {},
): Promise<SafeRemoteDocument> {
  const maxBytes = options.maxBytes ?? DEFAULT_REMOTE_DOCUMENT_LIMIT;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRedirects = options.maxRedirects ?? 3;
  let resolved = await resolveRemoteDocumentUrl(rawUrl);

  for (let redirects = 0; ; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const dispatcher = options.fetchImpl ? null : new Agent({
      connect: {
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions.all) callback(null, [{ address: resolved.address, family: resolved.family }]);
          else callback(null, resolved.address, resolved.family);
        },
      },
    });
    let response: Response;
    try {
      const init = {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/*;q=0.9,*/*;q=0.5" },
      } satisfies RequestInit;
      response = options.fetchImpl
        ? await options.fetchImpl(resolved.url, init)
        : await undiciFetch(resolved.url, { ...init, dispatcher: dispatcher! }) as unknown as Response;
    } catch (error) {
      clearTimeout(timer);
      await dispatcher?.close();
      if ((error as Error).name === "AbortError") throw new RemoteDocumentError("Document download timed out.", 408);
      throw new RemoteDocumentError("Document download failed.", 502);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      clearTimeout(timer);
      await response.body?.cancel();
      await dispatcher?.close();
      if (redirects >= maxRedirects) throw new RemoteDocumentError("Document URL redirected too many times.");
      const location = response.headers.get("location");
      if (!location) throw new RemoteDocumentError("Document redirect did not include a destination.", 502);
      resolved = await resolveRemoteDocumentUrl(new URL(location, resolved.url).toString());
      continue;
    }
    if (!response.ok) {
      clearTimeout(timer);
      await response.body?.cancel();
      await dispatcher?.close();
      throw new RemoteDocumentError(`Document server returned HTTP ${response.status}.`, 502);
    }

    const advertised = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > maxBytes) {
      clearTimeout(timer);
      await response.body?.cancel();
      await dispatcher?.close();
      throw new RemoteDocumentError(`Document exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`, 413);
    }
    if (!response.body) {
      clearTimeout(timer);
      await dispatcher?.close();
      throw new RemoteDocumentError("Document server returned an empty response.", 502);
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          throw new RemoteDocumentError(`Document exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB limit.`, 413);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error instanceof RemoteDocumentError) throw error;
      if ((error as Error).name === "AbortError") throw new RemoteDocumentError("Document download timed out.", 408);
      throw new RemoteDocumentError("Document download was interrupted.", 502);
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
      await dispatcher?.close();
    }
    return {
      buffer: Buffer.concat(chunks, received),
      contentType: (response.headers.get("content-type") || "").split(";")[0].toLowerCase(),
      finalUrl: resolved.url.toString(),
    };
  }
}
