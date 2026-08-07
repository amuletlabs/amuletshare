import { AppError, readJsonObject } from "../http/errors";
import { json } from "../http/responses";
import type { Env, FileRecord, MultipartRecord } from "../types";
import {
  cleanFilename,
  cleanMimeType,
  createAvailableFileId,
  DIRECT_UPLOAD_LIMIT,
  expiresAtForSize,
  fileUrl,
  MAX_FILE_SIZE,
  MULTIPART_TTL_MS,
  publicFile,
} from "../services/files";
import { getMultipart, insertMultipart } from "../services/metadata";
import { generateEditPassword, hashPassword, optionalPassword, validatePassword } from "../services/passwords";

async function activeUpload(env: Env, fileId: string, uploadId: string): Promise<MultipartRecord> {
  const record = await getMultipart(env, fileId, uploadId);
  if (!record) throw new AppError(404, "Upload not found");
  if (Date.parse(record.expires_at) <= Date.now()) {
    try {
      await env.FILES.resumeMultipartUpload(record.object_key, record.upload_id).abort();
      await env.DB.prepare("DELETE FROM multipart_uploads WHERE file_id = ?").bind(fileId).run();
    } catch (error) {
      console.warn("Could not remove expired multipart upload", { fileId, error });
    }
    throw new AppError(410, "Upload expired");
  }
  return record;
}

export async function createMultipartUpload(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  if (typeof body.filename !== "string" || body.filename.trim().length === 0) {
    throw new AppError(400, "filename is required");
  }
  if (!Number.isInteger(body.size) || (body.size as number) < DIRECT_UPLOAD_LIMIT) {
    throw new AppError(400, "size must be an integer of at least 100,000,000 bytes");
  }
  const size = body.size as number;
  if (size > MAX_FILE_SIZE) throw new AppError(413, "File exceeds the 1,000,000,000 byte limit");
  const fileName = cleanFilename(body.filename);
  const mimeType = body.mime_type === undefined || body.mime_type === null
    ? "application/octet-stream"
    : typeof body.mime_type === "string"
      ? cleanMimeType(body.mime_type)
      : (() => { throw new AppError(400, "mime_type must be a string"); })();
  const password = optionalPassword(body.password, "password");
  const editPassword = body.edit_password === undefined || body.edit_password === null || body.edit_password === ""
    ? generateEditPassword()
    : validatePassword(body.edit_password, "edit_password");
  const passwordHash = password ? await hashPassword(password) : null;
  const editPasswordHash = await hashPassword(editPassword);
  const fileId = await createAvailableFileId(env);
  const objectKey = `files/${fileId}`;
  const upload = await env.FILES.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: mimeType },
    customMetadata: { fileId },
  });
  const now = new Date();
  const record: MultipartRecord = {
    file_id: fileId,
    upload_id: upload.uploadId,
    object_key: objectKey,
    file_name: fileName,
    mime_type: mimeType,
    expected_size: size,
    password_hash: passwordHash,
    edit_password_hash: editPasswordHash,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + MULTIPART_TTL_MS).toISOString(),
  };
  try {
    await insertMultipart(env, record);
  } catch (error) {
    await upload.abort().catch(() => undefined);
    throw error;
  }
  return json({
    file_id: fileId,
    upload_id: upload.uploadId,
    upload_type: "multipart",
    edit_password: editPassword,
    url: fileUrl(request, env, fileId, fileName),
  }, 201);
}

export async function uploadPart(request: Request, env: Env, fileId: string): Promise<Response> {
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");
  const partNumber = Number(url.searchParams.get("partNumber"));
  if (!uploadId) throw new AppError(400, "uploadId is required");
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new AppError(400, "partNumber must be an integer from 1 to 10,000");
  }
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength <= 0) throw new AppError(400, "Part body cannot be empty");
    if (contentLength > DIRECT_UPLOAD_LIMIT) {
      throw new AppError(413, "Multipart parts cannot exceed 100,000,000 bytes");
    }
  }
  if (!request.body) throw new AppError(400, "Part body is required");
  const record = await activeUpload(env, fileId, uploadId);
  const upload = env.FILES.resumeMultipartUpload(record.object_key, record.upload_id);
  const part = await upload.uploadPart(partNumber, request.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

export async function completeMultipartUpload(request: Request, env: Env, fileId: string): Promise<Response> {
  const url = new URL(request.url);
  const uploadId = url.searchParams.get("uploadId");
  if (!uploadId) throw new AppError(400, "uploadId is required");
  const record = await activeUpload(env, fileId, uploadId);
  const body = await readJsonObject(request);
  if (!Array.isArray(body.parts) || body.parts.length === 0) throw new AppError(400, "parts is required");

  const parts: R2UploadedPart[] = body.parts.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new AppError(400, "Each part must be an object");
    }
    const part = value as Record<string, unknown>;
    if (!Number.isInteger(part.partNumber) || (part.partNumber as number) < 1 || (part.partNumber as number) > 10_000) {
      throw new AppError(400, "Each partNumber must be an integer from 1 to 10,000");
    }
    if (typeof part.etag !== "string" || part.etag.length === 0) throw new AppError(400, "Each part requires an etag");
    return { partNumber: part.partNumber as number, etag: part.etag };
  }).sort((a, b) => a.partNumber - b.partNumber);

  if (new Set(parts.map((part) => part.partNumber)).size !== parts.length) {
    throw new AppError(400, "Duplicate part numbers are not allowed");
  }

  const upload = env.FILES.resumeMultipartUpload(record.object_key, record.upload_id);
  let completed: R2Object;
  try {
    completed = await upload.complete(parts);
  } catch (error) {
    console.warn("Multipart completion rejected", error);
    throw new AppError(400, "Invalid multipart completion");
  }
  const object = await env.FILES.head(record.object_key);
  if (!object || object.size !== record.expected_size) {
    try {
      await env.FILES.delete(record.object_key);
      await env.DB.prepare("DELETE FROM multipart_uploads WHERE file_id = ?").bind(fileId).run();
    } catch (error) {
      console.warn("Could not remove invalid completed object", { fileId, error });
    }
    throw new AppError(400, "Completed file size does not match declared size");
  }

  const now = new Date();
  const file: FileRecord = {
    id: record.file_id,
    object_key: record.object_key,
    file_name: record.file_name,
    mime_type: record.mime_type,
    size_bytes: object.size,
    password_hash: record.password_hash,
    edit_password_hash: record.edit_password_hash,
    created_at: now.toISOString(),
    expires_at: expiresAtForSize(object.size, now),
    downloads: 0,
    last_downloaded_at: null,
  };
  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO files (
          id, object_key, file_name, mime_type, size_bytes, password_hash,
          edit_password_hash, created_at, expires_at, downloads, last_downloaded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        file.id,
        file.object_key,
        file.file_name,
        file.mime_type,
        file.size_bytes,
        file.password_hash,
        file.edit_password_hash,
        file.created_at,
        file.expires_at,
        file.downloads,
        file.last_downloaded_at,
      ),
      env.DB.prepare("DELETE FROM multipart_uploads WHERE file_id = ?").bind(fileId),
    ]);
  } catch (error) {
    try {
      await env.FILES.delete(record.object_key);
      await env.DB.prepare("DELETE FROM multipart_uploads WHERE file_id = ?").bind(fileId).run();
    } catch (cleanupError) {
      console.warn("Could not clean up failed multipart transition", { fileId, cleanupError });
    }
    throw error;
  }

  return json({ data: publicFile(file), url: fileUrl(request, env, file.id, file.file_name), etag: completed.etag });
}

export async function abortMultipartUpload(request: Request, env: Env, fileId: string): Promise<Response> {
  const uploadId = new URL(request.url).searchParams.get("uploadId");
  if (!uploadId) throw new AppError(400, "uploadId is required");
  const record = await activeUpload(env, fileId, uploadId);
  await env.FILES.resumeMultipartUpload(record.object_key, record.upload_id).abort();
  await env.DB.prepare("DELETE FROM multipart_uploads WHERE file_id = ?").bind(fileId).run();
  return json({ message: "Upload aborted successfully" });
}
