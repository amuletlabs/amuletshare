import { marked } from "marked";

const stylesheet = "/styles.css?v=20260807-6";

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
