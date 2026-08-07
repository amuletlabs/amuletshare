import { AppError } from "../http/errors";
import { cleanFilename, cleanMimeType, MAX_FILE_SIZE } from "./files";

const MAX_REDIRECTS = 5;
const WEB_DOCUMENT_MIME_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
]);

export type RemoteFetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface RemoteFile {
  body: ReadableStream<Uint8Array>;
  fileName: string;
  limitExceeded: () => boolean;
  mimeType: string;
  readFailed: () => boolean;
}

function ipv4Parts(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) return null;
  const values = parts.map(Number);
  return values.every((part) => part >= 0 && part <= 255) ? values : null;
}

export function isPublicRemoteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
  ) return false;

  const ipv4 = ipv4Parts(hostname);
  if (ipv4) {
    const [a, b] = ipv4;
    return !(
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 0 || b === 168))
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
    );
  }

  if (hostname.includes(":")) {
    return !(
      hostname === "::"
      || hostname === "::1"
      || hostname.startsWith("fc")
      || hostname.startsWith("fd")
      || hostname.startsWith("ff")
      || /^fe[89ab]/u.test(hostname)
      || hostname.startsWith("::ffff:")
    );
  }

  return hostname.length > 0;
}

function filenameFromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim().replace(/^"|"$/gu, ""));
    } catch {
      // Fall through to the plain filename parameter.
    }
  }
  const quoted = value.match(/filename\s*=\s*"([^"]*)"/iu)?.[1];
  if (quoted) return quoted.replace(/\\(["\\])/gu, "$1");
  return value.match(/filename\s*=\s*([^;\s]+)/iu)?.[1] || null;
}

export function remoteFilename(
  responseUrl: string,
  contentDisposition: string | null,
  requestedName?: string,
): string {
  if (requestedName) return cleanFilename(requestedName);
  const dispositionName = filenameFromContentDisposition(contentDisposition);
  if (dispositionName) return cleanFilename(dispositionName);
  try {
    const segment = new URL(responseUrl).pathname.split("/").filter(Boolean).at(-1);
    if (segment) return cleanFilename(decodeURIComponent(segment));
  } catch {
    // The URL was already validated; use the fallback if decoding its path fails.
  }
  return "file";
}

export function limitedStream(
  source: ReadableStream<Uint8Array>,
  maxBytes = MAX_FILE_SIZE,
): { body: ReadableStream<Uint8Array>; limitExceeded: () => boolean; readFailed: () => boolean } {
  const reader = source.getReader();
  let size = 0;
  let exceeded = false;
  let failed = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        failed = true;
        controller.error(error);
        return;
      }
      if (chunk.done) {
        controller.close();
        return;
      }
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        exceeded = true;
        await reader.cancel("File size limit exceeded").catch(() => undefined);
        controller.error(new AppError(413, "File exceeds the 1,000,000,000 byte limit"));
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { body, limitExceeded: () => exceeded, readFailed: () => failed };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchFollowingSafeRedirects(sourceUrl: string, fetcher: RemoteFetcher): Promise<{ response: Response; url: string }> {
  let currentUrl = sourceUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (!isPublicRemoteUrl(currentUrl)) throw new AppError(400, "url must be a public HTTP or HTTPS URL");
    let response: Response;
    try {
      response = await fetcher(currentUrl, {
        method: "GET",
        redirect: "manual",
        headers: { accept: "*/*", "accept-encoding": "identity" },
      });
    } catch {
      throw new AppError(400, "Could not download file from URL");
    }
    if (!isRedirect(response.status)) return { response, url: currentUrl };
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new AppError(400, "Could not follow file URL redirect");
    if (redirect === MAX_REDIRECTS) throw new AppError(400, "File URL has too many redirects");
    try {
      currentUrl = new URL(location, currentUrl).toString();
    } catch {
      throw new AppError(400, "File URL redirect is invalid");
    }
  }
  throw new AppError(400, "File URL has too many redirects");
}

export async function fetchRemoteFile(
  sourceUrl: string,
  fetcher: RemoteFetcher,
  options: { filename?: string; mimeType?: string } = {},
): Promise<RemoteFile> {
  const { response, url } = await fetchFollowingSafeRedirects(sourceUrl, fetcher);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppError(400, "Could not download file from URL");
  }
  if (!response.body) throw new AppError(400, "URL did not return file data");

  const contentDisposition = response.headers.get("content-disposition");
  const sourceMimeHeader = response.headers.get("content-type");
  const baseMimeType = sourceMimeHeader?.split(";", 1)[0].trim().toLowerCase() || "";
  const downloadsAsAttachment = /^\s*attachment(?:\s*;|\s*$)/iu.test(contentDisposition || "");
  if (WEB_DOCUMENT_MIME_TYPES.has(baseMimeType) && !downloadsAsAttachment) {
    await response.body.cancel().catch(() => undefined);
    throw new AppError(415, "URL points to a web page, not a file");
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_SIZE) {
    await response.body.cancel().catch(() => undefined);
    throw new AppError(413, "File exceeds the 1,000,000,000 byte limit");
  }

  const limited = limitedStream(response.body);
  return {
    body: limited.body,
    fileName: remoteFilename(url, contentDisposition, options.filename),
    limitExceeded: limited.limitExceeded,
    mimeType: options.mimeType ? cleanMimeType(options.mimeType) : cleanMimeType(baseMimeType),
    readFailed: limited.readFailed,
  };
}
