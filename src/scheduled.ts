import type { Env, FileRecord, MultipartRecord } from "./types";

export async function cleanupExpired(env: Env): Promise<{ files: number; uploads: number }> {
  const now = new Date().toISOString();
  const expiredFiles = await env.DB.prepare(`
    SELECT * FROM files
    WHERE expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY expires_at
    LIMIT 200
  `).bind(now).all<FileRecord>();
  const fileResults = await Promise.allSettled(expiredFiles.results.map(async (record) => {
    try {
      await env.FILES.delete(record.object_key);
      await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(record.id).run();
      return true;
    } catch (error) {
      console.warn("Could not delete expired object", { id: record.id, error });
      return false;
    }
  }));
  const files = fileResults.filter((result) => result.status === "fulfilled" && result.value).length;

  const expiredUploads = await env.DB.prepare(`
    SELECT * FROM multipart_uploads
    WHERE expires_at <= ?
    ORDER BY expires_at
    LIMIT 200
  `).bind(now).all<MultipartRecord>();
  const uploadResults = await Promise.allSettled(expiredUploads.results.map(async (record) => {
    try {
      await env.FILES.resumeMultipartUpload(record.object_key, record.upload_id).abort();
    } catch (abortError) {
      try {
        await env.FILES.delete(record.object_key);
      } catch (deleteError) {
        console.warn("Could not remove expired upload", { fileId: record.file_id, abortError, deleteError });
        return false;
      }
    }
    await env.DB.prepare("DELETE FROM multipart_uploads WHERE file_id = ?").bind(record.file_id).run();
    return true;
  }));
  const uploads = uploadResults.filter((result) => result.status === "fulfilled" && result.value).length;
  return { files, uploads };
}
