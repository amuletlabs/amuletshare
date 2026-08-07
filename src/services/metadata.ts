import type { Env, FileRecord, MultipartRecord } from "../types";

export async function insertFile(env: Env, record: FileRecord): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO files (
      id, object_key, file_name, mime_type, size_bytes, password_hash,
      edit_password_hash, created_at, expires_at, downloads, last_downloaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.id,
    record.object_key,
    record.file_name,
    record.mime_type,
    record.size_bytes,
    record.password_hash,
    record.edit_password_hash,
    record.created_at,
    record.expires_at,
    record.downloads,
    record.last_downloaded_at,
  ).run();
}

export async function insertMultipart(env: Env, record: MultipartRecord): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO multipart_uploads (
      file_id, upload_id, object_key, file_name, mime_type, expected_size,
      password_hash, edit_password_hash, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    record.file_id,
    record.upload_id,
    record.object_key,
    record.file_name,
    record.mime_type,
    record.expected_size,
    record.password_hash,
    record.edit_password_hash,
    record.created_at,
    record.expires_at,
  ).run();
}

export async function getMultipart(env: Env, fileId: string, uploadId: string): Promise<MultipartRecord | null> {
  return env.DB.prepare("SELECT * FROM multipart_uploads WHERE file_id = ? AND upload_id = ?")
    .bind(fileId, uploadId)
    .first<MultipartRecord>();
}
