import { AppError, errorResponse } from "./http/errors";
import { json, withCors } from "./http/responses";
import {
  createFile,
  deleteFile,
  downloadFile,
  fileInfo,
  updateFile,
} from "./routes/files";
import { localInspector } from "./routes/local-inspector";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  uploadPart,
} from "./routes/multipart";
import { cleanupExpired } from "./scheduled";
import type { Env } from "./types";
import llmsText from "../public/llms.txt";
import { acceptsHtml, renderLlmsPage } from "./pages";

function decodeId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new AppError(400, "Invalid file ID");
  }
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;

  if (
    request.method === "POST"
    && (pathname === "/api/files" || pathname === "/api/files/upload-url")
  ) {
    const actor = request.headers.get("cf-connecting-ip") || "local";
    const [actorLimit, globalLimit] = await Promise.all([
      env.UPLOAD_RATE_LIMITER.limit({ key: actor }),
      env.GLOBAL_UPLOAD_RATE_LIMITER.limit({ key: "file-creation" }),
    ]);
    if (!actorLimit.success || !globalLimit.success) {
      throw new AppError(429, "Too many uploads; retry in 60 seconds");
    }
  }

  if (request.method === "OPTIONS" && (pathname.startsWith("/api/") || pathname.startsWith("/f/"))) {
    return new Response(null, { status: 204 });
  }
  if (pathname === "/llms.txt") {
    if (request.method !== "GET" && request.method !== "HEAD") throw new AppError(405, "Method not allowed");
    const html = acceptsHtml(request);
    const content = html ? renderLlmsPage(llmsText) : llmsText;
    return new Response(request.method === "HEAD" ? null : content, {
      headers: {
        "content-type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300",
        "vary": "Accept, Sec-Fetch-Dest",
      },
    });
  }
  if (pathname === "/health" && request.method === "GET") {
    await env.DB.prepare("SELECT 1").first();
    return json({ status: "ok" });
  }
  if (pathname === "/api/files") {
    if (request.method !== "POST") throw new AppError(405, "POST required for this endpoint");
    return createFile(request, env);
  }
  if (pathname === "/api/files/upload-url") {
    if (request.method !== "POST") throw new AppError(405, "POST required for this endpoint");
    return createMultipartUpload(request, env);
  }

  let match = pathname.match(/^\/api\/files\/([^/]+)\/upload-part$/u);
  if (match) {
    if (request.method !== "POST") throw new AppError(405, "POST required for this endpoint");
    return uploadPart(request, env, decodeId(match[1]));
  }
  match = pathname.match(/^\/api\/files\/([^/]+)\/complete$/u);
  if (match) {
    if (request.method !== "POST") throw new AppError(405, "POST required for this endpoint");
    return completeMultipartUpload(request, env, decodeId(match[1]));
  }
  match = pathname.match(/^\/api\/files\/([^/]+)\/abort$/u);
  if (match) {
    if (request.method !== "DELETE") throw new AppError(405, "DELETE required for this endpoint");
    return abortMultipartUpload(request, env, decodeId(match[1]));
  }
  match = pathname.match(/^\/api\/files\/([^/]+)\/info$/u);
  if (match) {
    if (request.method !== "GET") throw new AppError(405, "GET required for this endpoint");
    return fileInfo(request, env, decodeId(match[1]));
  }
  match = pathname.match(/^\/api\/files\/([^/]+)$/u);
  if (match) {
    const id = decodeId(match[1]);
    if (request.method === "GET") return downloadFile(request, env, id);
    if (request.method === "PATCH") return updateFile(request, env, id);
    if (request.method === "DELETE") return deleteFile(request, env, id);
    throw new AppError(405, "Method not allowed");
  }

  match = pathname.match(/^\/f\/([^/.]+)(?:\.[^/]*)?$/u);
  if (match) {
    if (request.method !== "GET") throw new AppError(405, "GET required for file downloads");
    return downloadFile(request, env, decodeId(match[1]), true);
  }
  if (pathname === "/__local" || pathname === "/__local/data") return localInspector(request, env);

  if (pathname.startsWith("/api/")) throw new AppError(404, "API endpoint not found");
  if (pathname.startsWith("/f/")) throw new AppError(404, "File not found");
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return withCors(await route(request, env));
    } catch (error) {
      return withCors(errorResponse(error));
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(cleanupExpired(env).then((result) => {
      console.log("Expiration cleanup complete", result);
    }));
  },
};
