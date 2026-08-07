import { AppError, readJsonObject } from "../http/errors";
import { json } from "../http/responses";
import type { Env, FileRecord } from "../types";
import {
  cleanFilename,
  cleanMimeType,
  contentDisposition,
  createAvailableFileId,
  DIRECT_UPLOAD_LIMIT,
  expiresAtForSize,
  fileUrl,
  isSafeInlineImage,
  MAX_FILE_SIZE,
  publicFile,
  requireActiveFile,
} from "../services/files";
import { insertFile } from "../services/metadata";
import {
  generateEditPassword,
  hashPassword,
  optionalPassword,
  validatePassword,
  verifyPassword,
} from "../services/passwords";

function optionalFormString(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AppError(400, `${name} must be text`);
  return value;
}

async function createRecord(
  env: Env,
  id: string,
  objectKey: string,
  fileName: string,
  mimeType: string,
  sizeBytes: number,
  password: string | null,
  editPassword: string,
  now = new Date(),
): Promise<FileRecord> {
  return {
    id,
    object_key: objectKey,
    file_name: fileName,
    mime_type: mimeType,
    size_bytes: sizeBytes,
    password_hash: password ? await hashPassword(password) : null,
    edit_password_hash: await hashPassword(editPassword),
    created_at: now.toISOString(),
    expires_at: expiresAtForSize(sizeBytes, now),
    downloads: 0,
    last_downloaded_at: null,
  };
}

async function uploadDirect(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AppError(400, "Invalid multipart form data");
  }
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError(400, "file is required");
  if (form.getAll("file").length !== 1) throw new AppError(400, "Exactly one file is required");
  if (file.size >= DIRECT_UPLOAD_LIMIT) {
    throw new AppError(413, "Files 100,000,000 bytes or larger require multipart upload");
  }
  if (file.size > MAX_FILE_SIZE) throw new AppError(413, "File exceeds the 1,000,000,000 byte limit");

  const requestedName = optionalFormString(form, "filename");
  const requestedType = optionalFormString(form, "mime_type");
  const password = optionalPassword(optionalFormString(form, "password"), "password");
  const suppliedEditPassword = optionalFormString(form, "edit_password");
  const editPassword = suppliedEditPassword
    ? validatePassword(suppliedEditPassword, "edit_password")
    : generateEditPassword();
  const fileName = cleanFilename(requestedName || file.name || "file");
  const mimeType = cleanMimeType(requestedType || file.type);
  const id = await createAvailableFileId(env);
  const objectKey = `files/${id}`;
  const record = await createRecord(env, id, objectKey, fileName, mimeType, file.size, password, editPassword);

  await env.FILES.put(objectKey, file.stream(), {
    httpMetadata: { contentType: mimeType },
    customMetadata: { fileId: id },
  });
  try {
    await insertFile(env, record);
  } catch (error) {
    await env.FILES.delete(objectKey).catch(() => undefined);
    throw error;
  }

  return json({ data: publicFile(record), edit_password: editPassword, url: fileUrl(request, env, id, fileName) }, 201);
}

export async function createFile(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) return uploadDirect(request, env);
  throw new AppError(415, "Use multipart/form-data");
}

async function authorizeView(record: FileRecord, request: Request): Promise<void> {
  if (!record.password_hash) return;
  const supplied = new URL(request.url).searchParams.get("password");
  if (supplied === null) throw new AppError(401, "Password required");
  if (!(await verifyPassword(supplied, record.password_hash))) throw new AppError(403, "Invalid password");
}

export async function downloadFile(request: Request, env: Env, id: string): Promise<Response> {
  const record = await requireActiveFile(env, id);
  await authorizeView(record, request);
  const object = await env.FILES.get(record.object_key);
  if (!object) {
    await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
    throw new AppError(404, "File not found");
  }

  const downloadedAt = new Date().toISOString();
  await env.DB.prepare(`
    UPDATE files
    SET downloads = downloads + 1, last_downloaded_at = ?
    WHERE id = ?
  `).bind(downloadedAt, id).run();

  const forceDownload = new URL(request.url).searchParams.get("download") === "1";
  const disposition = !forceDownload && isSafeInlineImage(record.mime_type) ? "inline" : "attachment";

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": record.mime_type,
      "content-length": String(object.size),
      "content-disposition": contentDisposition(record.file_name, disposition),
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      etag: object.httpEtag,
    },
  });
}

export async function fileInfo(request: Request, env: Env, id: string): Promise<Response> {
  const record = await requireActiveFile(env, id);
  await authorizeView(record, request);
  return json(publicFile(record, true));
}

export async function updateFile(request: Request, env: Env, id: string): Promise<Response> {
  const record = await requireActiveFile(env, id);
  const body = await readJsonObject(request);
  const editPassword = validatePassword(body.edit_password, "edit_password");
  const newPassword = validatePassword(body.password, "password");
  if (!(await verifyPassword(editPassword, record.edit_password_hash))) {
    throw new AppError(403, "Invalid edit password");
  }
  record.password_hash = await hashPassword(newPassword);
  await env.DB.prepare("UPDATE files SET password_hash = ? WHERE id = ?")
    .bind(record.password_hash, id)
    .run();
  return json({ data: publicFile(record, true) });
}

export async function deleteFile(request: Request, env: Env, id: string): Promise<Response> {
  const record = await requireActiveFile(env, id);
  const body = await readJsonObject(request);
  const editPassword = validatePassword(body.edit_password, "edit_password");
  if (!(await verifyPassword(editPassword, record.edit_password_hash))) {
    throw new AppError(403, "Invalid edit password");
  }

  await env.FILES.delete(record.object_key);
  await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
  return json({ message: "File deleted successfully" });
}
