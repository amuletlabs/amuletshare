import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { errorResponse } from "../src/http/errors";
import { createFile } from "../src/routes/files";
import { cleanupExpired } from "../src/scheduled";
import type { RemoteFetcher } from "../src/services/url-imports";
import worker from "../src/index";

const origin = "https://share.test";

function dispatch(input: string, init?: RequestInit): Promise<Response> {
  return worker.fetch(new Request(input, init), env);
}

async function body(response: Response): Promise<Record<string, any>> {
  return response.json<Record<string, any>>();
}

async function upload(
  contents: string,
  options: {
    password?: string;
    editPassword?: string;
    filename?: string;
    mimeType?: string;
  } = {},
) {
  const form = new FormData();
  form.set("file", new File([contents], options.filename || "sample.txt", { type: options.mimeType || "text/plain" }));
  if (options.password) form.set("password", options.password);
  if (options.editPassword) form.set("edit_password", options.editPassword);
  const response = await dispatch(`${origin}/api/files`, {
    method: "POST",
    headers: { "cf-connecting-ip": `test-${crypto.randomUUID()}` },
    body: form,
  });
  return { response, value: await body(response) };
}

async function importUrl(
  value: Record<string, unknown>,
  fetcher: RemoteFetcher,
): Promise<Response> {
  const request = new Request(`${origin}/api/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  try {
    return await createFile(request, env, fetcher);
  } catch (error) {
    return errorResponse(error);
  }
}

describe("file API", () => {
  it("returns concise JSON messages for routing and server errors", async () => {
    const cases = [
      [await dispatch(`${origin}/api/files`, { method: "GET" }), 405, "POST required for this endpoint"],
      [await dispatch(`${origin}/api/files/upload-url`, { method: "GET" }), 405, "POST required for this endpoint"],
      [await dispatch(`${origin}/api/files/file-id/upload-part`, { method: "GET" }), 405, "POST required for this endpoint"],
      [await dispatch(`${origin}/api/files/file-id/complete`, { method: "GET" }), 405, "POST required for this endpoint"],
      [await dispatch(`${origin}/api/files/file-id/abort`, { method: "GET" }), 405, "DELETE required for this endpoint"],
      [await dispatch(`${origin}/api/files/file-id/info`, { method: "POST" }), 405, "GET required for this endpoint"],
      [await dispatch(`${origin}/f/file-id.txt`, { method: "POST" }), 405, "GET required for file downloads"],
      [await dispatch(`${origin}/api/unknown`), 404, "API endpoint not found"],
      [await dispatch(`${origin}/f/not/a/file`), 404, "File not found"],
      [errorResponse(new Error("private detail")), 500, "Internal server error; retry later"],
    ] as const;

    for (const [response, status, message] of cases) {
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await body(response)).toEqual({ error: message });
      expect(message.length).toBeLessThanOrEqual(80);
    }
  });

  it("serves raw llms.txt to agents and rendered documentation to browsers", async () => {
    const raw = await dispatch(`${origin}/llms.txt`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("text/plain");
    expect(await raw.text()).toContain("# share.amulet.so");

    const html = await dispatch(`${origin}/llms.txt`, {
      headers: { accept: "text/html" },
    });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("<h1>share.amulet.so</h1>");

    const forcedRaw = await dispatch(`${origin}/llms.txt?raw=1`, {
      headers: { accept: "text/html" },
    });
    expect(forcedRaw.headers.get("content-type")).toContain("text/plain");
  });

  it("uploads and downloads public bytes directly", async () => {
    const created = await upload("hello from workerd");
    expect(created.response.status).toBe(201);
    expect(created.value.data.expires_at).toBeNull();
    expect(created.value.edit_password).toBeTypeOf("string");
    expect(created.value.data.object_key).toBeUndefined();

    const info = await dispatch(`${origin}/api/files/${created.value.data.id}/info`);
    expect(info.status).toBe(200);
    expect((await body(info)).downloads).toBe(0);

    const downloaded = await dispatch(`${origin}/api/files/${created.value.data.id}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain("sample.txt");
    expect(downloaded.headers.get("content-disposition")).toMatch(/^attachment;/u);
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await downloaded.text()).toBe("hello from workerd");

    const after = await body(await dispatch(`${origin}/api/files/${created.value.data.id}/info`));
    expect(after.downloads).toBe(1);
  });

  it("opens only safe raster image types inline and supports forced downloads", async () => {
    const safeTypes = [
      ["image/jpeg", "photo.jpg"],
      ["image/png", "image.png"],
      ["image/gif", "animation.gif"],
      ["image/webp", "image.webp"],
      ["image/avif", "image.avif"],
    ] as const;

    for (const [mimeType, filename] of safeTypes) {
      const contents = `bytes for ${mimeType}`;
      const created = await upload(contents, { filename, mimeType });
      const id = created.value.data.id;
      const inline = await dispatch(`${origin}/f/${id}`);
      expect(inline.headers.get("content-type")).toBe(mimeType);
      expect(inline.headers.get("content-disposition")).toMatch(/^inline;/u);
      expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new TextDecoder().decode(await inline.arrayBuffer())).toBe(contents);

      const forced = await dispatch(`${origin}/f/${id}?download=1`);
      expect(forced.headers.get("content-disposition")).toMatch(/^attachment;/u);
      expect(forced.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new TextDecoder().decode(await forced.arrayBuffer())).toBe(contents);
    }

    for (const [mimeType, filename] of [
      ["text/html", "page.html"],
      ["image/svg+xml", "vector.svg"],
      ["application/octet-stream", "file.bin"],
    ] as const) {
      const created = await upload("unsafe bytes", { filename, mimeType });
      const response = await dispatch(`${origin}/f/${created.value.data.id}`);
      expect(response.headers.get("content-disposition")).toMatch(/^attachment;/u);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("separates view and edit passwords", async () => {
    const created = await upload("protected", { password: "first-view", editPassword: "manage-file" });
    const id = created.value.data.id;
    expect((await dispatch(`${origin}/api/files/${id}`)).status).toBe(401);
    expect((await dispatch(`${origin}/api/files/${id}?password=wrong`)).status).toBe(403);
    expect((await dispatch(`${origin}/api/files/${id}?password=first-view`)).status).toBe(200);

    const wrongPatch = await dispatch(`${origin}/api/files/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edit_password: "wrong", password: "second-view" }),
    });
    expect(wrongPatch.status).toBe(403);
    const patched = await dispatch(`${origin}/api/files/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edit_password: "manage-file", password: "second-view" }),
    });
    expect(patched.status).toBe(200);
    expect((await dispatch(`${origin}/api/files/${id}?password=first-view`)).status).toBe(403);
    expect((await dispatch(`${origin}/api/files/${id}?password=second-view`)).status).toBe(200);

    const removed = await dispatch(`${origin}/api/files/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edit_password: "manage-file" }),
    });
    expect(removed.status).toBe(200);
    expect(await body(removed)).toEqual({ message: "File deleted successfully" });
    expect((await dispatch(`${origin}/api/files/${id}`)).status).toBe(404);
  });

  it("validates direct and multipart request shapes", async () => {
    const unsupported = await dispatch(`${origin}/api/files`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "bad",
    });
    expect(unsupported.status).toBe(415);
    expect(await body(unsupported)).toEqual({ error: "Use multipart/form-data or application/json" });

    const invalidJsonUpload = await dispatch(`${origin}/api/files`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "bad",
    });
    expect(invalidJsonUpload.status).toBe(415);
    expect(await body(invalidJsonUpload)).toEqual({ error: "Use multipart/form-data or application/json" });

    const tooSmall = await dispatch(`${origin}/api/files/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "small.bin", size: 99_999_999 }),
    });
    expect(tooSmall.status).toBe(400);

    const tooLarge = await dispatch(`${origin}/api/files/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "large.bin", size: 1_000_000_001 }),
    });
    expect(tooLarge.status).toBe(413);

  });

  it("clones a redirected remote file and stores its exact bytes", async () => {
    const calls: Array<{ init: RequestInit; url: string }> = [];
    const fetcher: RemoteFetcher = async (url, init) => {
      calls.push({ url, init });
      if (url === "https://files.example/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "/downloads/report" },
        });
      }
      return new Response("remote file bytes", {
        status: 200,
        headers: {
          "content-disposition": "attachment; filename*=UTF-8''report%20final.txt",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    };

    const response = await importUrl({
      url: "https://files.example/start",
      edit_password: "manage-remote",
    }, fetcher);
    expect(response.status).toBe(201);
    const created = await body(response);
    expect(created.data.file_name).toBe("report final.txt");
    expect(created.data.mime_type).toBe("text/plain");
    expect(created.data.size_bytes).toBe(17);
    expect(created.data.expires_at).toBeNull();
    expect(created.edit_password).toBe("manage-remote");
    expect(created.url).toMatch(/\/f\/[a-f0-9]{16}\.txt$/u);
    expect(calls.map((call) => call.url)).toEqual([
      "https://files.example/start",
      "https://files.example/downloads/report",
    ]);
    expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);

    const downloaded = await dispatch(`${origin}/api/files/${created.data.id}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("text/plain");
    expect(await downloaded.text()).toBe("remote file bytes");
  });

  it("streams URL imports across multiple R2 parts", async () => {
    const size = (8 * 1024 * 1024) + 3;
    const response = await importUrl(
      { url: "https://files.example/archive.bin" },
      async () => new Response(new Uint8Array(size), {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    expect(response.status).toBe(201);
    const created = await body(response);
    expect(created.data.size_bytes).toBe(size);
    const downloaded = await dispatch(`${origin}/api/files/${created.data.id}`);
    expect(Number(downloaded.headers.get("content-length"))).toBe(size);
    expect((await downloaded.arrayBuffer()).byteLength).toBe(size);
  });

  it("rejects unsafe, unavailable, HTML, empty, and oversized URL sources", async () => {
    const unusedFetcher = vi.fn<RemoteFetcher>();
    for (const value of [
      {},
      { url: "not a URL" },
      { url: "file:///etc/passwd" },
      { url: "http://127.0.0.1/private" },
      { url: "https://user:secret@example.com/file" },
    ]) {
      const response = await importUrl(value, unusedFetcher);
      expect(response.status).toBe(400);
    }
    expect(unusedFetcher).not.toHaveBeenCalled();

    const missing = await importUrl(
      { url: "https://files.example/missing" },
      async () => new Response("missing", { status: 404, headers: { "content-type": "text/plain" } }),
    );
    expect(missing.status).toBe(400);
    expect(await body(missing)).toEqual({ error: "Could not download file from URL" });

    const html = await importUrl(
      { url: "https://www.youtube.com/watch?v=example" },
      async () => new Response("<!doctype html><title>video</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    expect(html.status).toBe(415);
    expect(await body(html)).toEqual({ error: "URL points to a web page, not a file" });

    const empty = await importUrl(
      { url: "https://files.example/no-content" },
      async () => new Response(null, { status: 204 }),
    );
    expect(empty.status).toBe(400);
    expect(await body(empty)).toEqual({ error: "URL did not return file data" });

    const oversized = await importUrl(
      { url: "https://files.example/huge.bin" },
      async () => new Response("", {
        headers: {
          "content-length": "1000000001",
          "content-type": "application/octet-stream",
        },
      }),
    );
    expect(oversized.status).toBe(413);
    expect(await body(oversized)).toEqual({ error: "File exceeds the 1,000,000,000 byte limit" });
  });

  it("creates and aborts multipart uploads", async () => {
    const createResponse = await dispatch(`${origin}/api/files/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "large.bin", size: 100_000_000 }),
    });
    expect(createResponse.status).toBe(201);
    const created = await body(createResponse);
    expect(created.upload_type).toBe("multipart");
    expect(created.edit_password).toBeTypeOf("string");
    expect((await dispatch(`${origin}/api/files/${created.file_id}/info`)).status).toBe(404);

    const aborted = await dispatch(
      `${origin}/api/files/${created.file_id}/abort?uploadId=${encodeURIComponent(created.upload_id)}`,
      { method: "DELETE" },
    );
    expect(aborted.status).toBe(200);
    expect((await body(aborted)).message).toContain("aborted");
  });

  it("removes expired metadata and private R2 objects", async () => {
    await env.FILES.put("files/expired", "old");
    await env.DB.prepare(`
      INSERT INTO files (
        id, object_key, file_name, mime_type, size_bytes, password_hash,
        edit_password_hash, created_at, expires_at, downloads, last_downloaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      "expired",
      "files/expired",
      "old.txt",
      "text/plain",
      50_000_000,
      null,
      "unused",
      "2020-01-01T00:00:00.000Z",
      "2020-01-08T00:00:00.000Z",
      0,
      null,
    ).run();
    expect(await env.FILES.head("files/expired")).not.toBeNull();
    expect(await cleanupExpired(env)).toEqual({ files: 1, uploads: 0 });
    expect(await env.FILES.head("files/expired")).toBeNull();
    expect(await env.DB.prepare("SELECT id FROM files WHERE id = ?").bind("expired").first()).toBeNull();
  });
});
