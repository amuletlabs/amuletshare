import { AppError } from "../http/errors";
import { json } from "../http/responses";
import type { Env, FileRecord, MultipartRecord } from "../types";

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function state(env: Env) {
  const files = await env.DB.prepare(`
    SELECT id, object_key, file_name, mime_type, size_bytes, created_at,
      expires_at, downloads, last_downloaded_at
    FROM files ORDER BY created_at DESC LIMIT 100
  `).all<Omit<FileRecord, "password_hash" | "edit_password_hash">>();
  const uploads = await env.DB.prepare(`
    SELECT file_id, upload_id, object_key, file_name, mime_type, expected_size,
      created_at, expires_at
    FROM multipart_uploads ORDER BY created_at DESC LIMIT 100
  `).all<Omit<MultipartRecord, "password_hash" | "edit_password_hash">>();
  const fileRows = await Promise.all(files.results.map(async (file) => ({
    ...file,
    r2_exists: Boolean(await env.FILES.head(file.object_key)),
  })));
  return { files: fileRows, uploads: uploads.results };
}

export async function localInspector(request: Request, env: Env): Promise<Response> {
  if (env.ENVIRONMENT !== "local" && env.ENVIRONMENT !== "test") throw new AppError(404, "Not found");
  if (new URL(request.url).pathname === "/__local/data") return json(await state(env));
  const data = await state(env);
  const fileRows = data.files.map((file) => `
    <tr>
      <td><code>${escapeHtml(file.id)}</code></td>
      <td>${escapeHtml(file.file_name)}</td>
      <td>${Number(file.size_bytes).toLocaleString()}</td>
      <td>${escapeHtml(file.expires_at || "never")}</td>
      <td>${file.downloads}</td>
      <td>${file.r2_exists ? "yes" : "no"}</td>
    </tr>
  `).join("");
  const uploadRows = data.uploads.map((upload) => `
    <tr>
      <td><code>${escapeHtml(upload.file_id)}</code></td>
      <td>${escapeHtml(upload.file_name)}</td>
      <td>${Number(upload.expected_size).toLocaleString()}</td>
      <td>${escapeHtml(upload.expires_at)}</td>
    </tr>
  `).join("");
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>share local state</title><style>
body{font:15px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;margin:32px;color:#111}a{color:#00e}
table{border-collapse:collapse;width:100%;margin:12px 0 36px}th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}
th{font-weight:700}code{font:inherit}.muted{color:#666}
</style></head><body><p><a href="/">← upload page</a> · <a href="/__local/data">JSON</a></p>
<h1>Local state</h1><p class="muted">Passwords and internal hashes are intentionally hidden.</p>
<h2>Files (${data.files.length})</h2><table><thead><tr><th>ID</th><th>Name</th><th>Bytes</th><th>Expires</th><th>Downloads</th><th>R2</th></tr></thead><tbody>${fileRows || "<tr><td colspan=6>No files</td></tr>"}</tbody></table>
<h2>Multipart uploads (${data.uploads.length})</h2><table><thead><tr><th>ID</th><th>Name</th><th>Expected bytes</th><th>Upload expires</th></tr></thead><tbody>${uploadRows || "<tr><td colspan=4>No uploads</td></tr>"}</tbody></table>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
