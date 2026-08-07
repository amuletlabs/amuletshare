import { marked } from "marked";
import { filePreviewKind, type FilePreviewKind } from "./services/files";
import type { FileRecord } from "./types";

const stylesheet = "/styles.css?v=20260807-7";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function modeUrl(requestUrl: string, mode: "download" | "preview" | "raw"): string {
  const url = new URL(requestUrl);
  url.searchParams.delete("download");
  url.searchParams.delete("preview");
  url.searchParams.delete("raw");
  url.searchParams.set(mode, "1");
  return `${url.pathname}${url.search}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="API documentation for share.amulet.so.">
    <title>${title}</title>
    <link rel="stylesheet" href="${stylesheet}">
  </head>
  <body>
    <main class="doc-page">
      <nav class="doc-nav" aria-label="Documentation">
        <a href="/">← share.amulet.so</a>
        <a href="/llms.txt?raw=1">Raw text</a>
      </nav>
      <article class="markdown-body">
        ${body}
      </article>
      <footer>
        Built for agents, backed by <a href="https://www.ycombinator.com/companies/amulet">YC</a>. <a href="/terms">Terms</a>
      </footer>
    </main>
  </body>
</html>`;
}

export function acceptsHtml(request: Request): boolean {
  const url = new URL(request.url);
  if (url.searchParams.get("raw") === "1") return false;
  if (request.headers.get("sec-fetch-dest") === "document") return true;
  return request.headers.get("accept")?.includes("text/html") ?? false;
}

export function renderLlmsPage(markdown: string): string {
  const body = marked.parse(markdown, { async: false, gfm: true });
  return pageShell("API — share.amulet.so", body);
}

function previewElement(kind: FilePreviewKind | null, record: FileRecord, previewUrl: string): string {
  const name = escapeHtml(record.file_name);
  switch (kind) {
    case "image":
      return `<div class="file-preview-media"><img src="${escapeHtml(previewUrl)}" alt="${name}"></div>`;
    case "audio":
      return `<div class="file-preview-media"><audio src="${escapeHtml(previewUrl)}" controls preload="metadata"></audio></div>`;
    case "video":
      return `<div class="file-preview-media"><video src="${escapeHtml(previewUrl)}" controls preload="metadata"></video></div>`;
    case "pdf":
      return `<iframe class="file-preview-frame" src="${escapeHtml(previewUrl)}" title="Preview of ${name}"></iframe>`;
    case "markdown":
    case "text":
    case "web":
      return `<iframe class="file-preview-frame" src="${escapeHtml(previewUrl)}" title="Preview of ${name}" sandbox="allow-same-origin"></iframe>`;
    default:
      return `<section class="preview-unavailable" aria-label="Preview unavailable">
        <h2>Preview isn’t available for this file type.</h2>
        <p>The file is still available through the Raw and Download links above.</p>
      </section>`;
  }
}

export function renderFilePage(record: FileRecord, requestUrl: string): string {
  const kind = filePreviewKind(record);
  const rawUrl = modeUrl(requestUrl, "raw");
  const previewUrl = modeUrl(requestUrl, "preview");
  const downloadUrl = modeUrl(requestUrl, "download");
  const name = escapeHtml(record.file_name);
  const mimeType = escapeHtml(record.mime_type);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Shared file preview on share.amulet.so.">
    <title>${name} — share.amulet.so</title>
    <link rel="stylesheet" href="${stylesheet}">
  </head>
  <body class="file-view-page">
    <header class="file-toolbar">
      <a href="/">← share.amulet.so</a>
      <nav aria-label="File actions">
        <a href="${escapeHtml(rawUrl)}">Raw</a>
        <a href="${escapeHtml(downloadUrl)}">Download</a>
      </nav>
    </header>
    <main class="file-viewer">
      <div class="file-view-heading">
        <h1>${name}</h1>
        <p>${mimeType} · ${formatBytes(record.size_bytes)}</p>
      </div>
      ${previewElement(kind, record, previewUrl)}
    </main>
  </body>
</html>`;
}

export function renderMarkdownPreview(markdown: string, filename: string): string {
  const body = marked.parse(markdown, { async: false, gfm: true });
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(filename)}</title>
    <link rel="stylesheet" href="${stylesheet}">
  </head>
  <body>
    <main class="markdown-preview markdown-body">
      ${body}
    </main>
  </body>
</html>`;
}
