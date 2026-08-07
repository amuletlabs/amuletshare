import { AppError } from "../http/errors";
import type { Env, FileRecord, PublicFile } from "../types";

export const PERMANENT_LIMIT = 50_000_000;
export const DIRECT_UPLOAD_LIMIT = 100_000_000;
export const MAX_FILE_SIZE = 1_000_000_000;
export const MULTIPART_TTL_MS = 24 * 60 * 60 * 1000;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function cleanFilename(value: string): string {
  const cleaned = value
    .replace(/[\\/]/gu, "_")
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .slice(0, 255);
  return cleaned || "file";
}

export function cleanMimeType(value: string | null | undefined): string {
  if (!value) return "application/octet-stream";
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 255);
  return /^[^\s/]+\/[^\s/]+$/u.test(cleaned) ? cleaned : "application/octet-stream";
}

export function expiresAtForSize(size: number, now = new Date()): string | null {
  return size < PERMANENT_LIMIT ? null : new Date(now.getTime() + RETENTION_MS).toISOString();
}

export function publicFile(record: FileRecord, includeLastDownload = false): PublicFile {
  const value: PublicFile = {
    id: record.id,
    file_name: record.file_name,
    mime_type: record.mime_type,
    size_bytes: record.size_bytes,
    expires_at: record.expires_at,
    created_at: record.created_at,
    downloads: record.downloads,
  };
  if (includeLastDownload) value.last_downloaded_at = record.last_downloaded_at;
  return value;
}

export function fileExtension(filename: string): string {
  const match = filename.match(/\.([a-zA-Z0-9]{1,16})$/u);
  return match ? `.${match[1].toLowerCase()}` : "";
}

export function fileUrl(request: Request, env: Env, id: string, filename: string): string {
  const requestUrl = new URL(request.url);
  const localHost = env.ENVIRONMENT === "local" ? request.headers.get("host") : null;
  const requestOrigin = localHost ? `${requestUrl.protocol}//${localHost}` : requestUrl.origin;
  const base = env.BASE_URL.trim() || requestOrigin;
  return `${base.replace(/\/$/u, "")}/f/${id}${fileExtension(filename)}`;
}

export function createFileId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

export async function createAvailableFileId(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = createFileId();
    const collision = await env.DB.prepare(`
      SELECT id FROM files WHERE id = ?
      UNION ALL
      SELECT file_id AS id FROM multipart_uploads WHERE file_id = ?
      LIMIT 1
    `).bind(id, id).first<{ id: string }>();
    if (!collision) return id;
  }
  throw new AppError(500, "Could not allocate file ID");
}

export function isSafeInlineImage(mimeType: string): boolean {
  const baseType = mimeType.split(";", 1)[0].trim().toLowerCase();
  return INLINE_IMAGE_MIME_TYPES.has(baseType);
}

export function contentDisposition(filename: string, disposition: "attachment" | "inline" = "attachment"): string {
  const ascii = filename.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_") || "file";
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export async function requireActiveFile(env: Env, id: string): Promise<FileRecord> {
  const record = await env.DB.prepare("SELECT * FROM files WHERE id = ?").bind(id).first<FileRecord>();
  if (!record) throw new AppError(404, "File not found");
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
    try {
      await env.FILES.delete(record.object_key);
      await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
    } catch (error) {
      console.warn("Could not remove expired file", { id, error });
    }
    throw new AppError(410, "File expired");
  }
  return record;
}
