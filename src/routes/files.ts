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
import { fetchRemoteFile, type RemoteFetcher, type RemoteFile } from "../services/url-imports";

const REMOTE_PART_SIZE = 8 * 1024 * 1024;

function optionalFormString(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AppError(400, `${name} must be text`);
  return value;
}

function optionalJsonString(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new AppError(400, `${name} must be a string`);
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

async function uploadFromUrl(
  request: Request,
  env: Env,
  fetcher: RemoteFetcher,
): Promise<Response> {
  const body = await readJsonObject(request);
  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    throw new AppError(400, "url is required");
  }
  const requestedName = optionalJsonString(body, "filename");
  const requestedType = optionalJsonString(body, "mime_type");
  const password = optionalPassword(body.password, "password");
  const suppliedEditPassword = optionalJsonString(body, "edit_password");
  const editPassword = suppliedEditPassword
    ? validatePassword(suppliedEditPassword, "edit_password")
    : generateEditPassword();
  const remote = await fetchRemoteFile(body.url.trim(), fetcher, {
    filename: requestedName,
    mimeType: requestedType,
  });
  const id = await createAvailableFileId(env);
  const objectKey = `files/${id}`;
  let object: R2Object;
  try {
    object = await storeRemoteFile(env, objectKey, id, remote);
  } catch (error) {
    await env.FILES.delete(objectKey).catch(() => undefined);
    if (remote.limitExceeded()) throw new AppError(413, "File exceeds the 1,000,000,000 byte limit");
    if (remote.readFailed()) throw new AppError(400, "Could not download file from URL");
    throw error;
  }

  let record: FileRecord;
  try {
    record = await createRecord(
      env,
      id,
      objectKey,
      remote.fileName,
      remote.mimeType,
      object.size,
      password,
      editPassword,
    );
    await insertFile(env, record);
  } catch (error) {
    await env.FILES.delete(objectKey).catch(() => undefined);
    throw error;
  }

  return json({ data: publicFile(record), edit_password: editPassword, url: fileUrl(request, env, id, remote.fileName) }, 201);
}

async function storeRemoteFile(env: Env, objectKey: string, fileId: string, remote: RemoteFile): Promise<R2Object> {
  const reader = remote.body.getReader();
  const buffer = new Uint8Array(REMOTE_PART_SIZE);
  let buffered = 0;
  let upload: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [];
  const createUpload = async (): Promise<R2MultipartUpload> => {
    upload ||= await env.FILES.createMultipartUpload(objectKey, {
      httpMetadata: { contentType: remote.mimeType },
      customMetadata: { fileId },
    });
    return upload;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      let offset = 0;
      while (offset < chunk.value.byteLength) {
        const copied = Math.min(REMOTE_PART_SIZE - buffered, chunk.value.byteLength - offset);
        buffer.set(chunk.value.subarray(offset, offset + copied), buffered);
        buffered += copied;
        offset += copied;
        if (buffered === REMOTE_PART_SIZE) {
          const activeUpload = await createUpload();
          parts.push(await activeUpload.uploadPart(parts.length + 1, buffer.slice()));
          buffered = 0;
        }
      }
    }

    if (parts.length === 0 && buffered === 0) {
      return await env.FILES.put(objectKey, new Uint8Array(), {
        httpMetadata: { contentType: remote.mimeType },
        customMetadata: { fileId },
      });
    }
    const activeUpload = await createUpload();
    if (buffered > 0) parts.push(await activeUpload.uploadPart(parts.length + 1, buffer.slice(0, buffered)));
    return await activeUpload.complete(parts);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await upload?.abort().catch(() => undefined);
    throw error;
  }
}

export async function createFile(
  request: Request,
  env: Env,
  fetcher: RemoteFetcher = (url, init) => fetch(url, init),
): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) return uploadDirect(request, env);
  if (contentType.toLowerCase().startsWith("application/json")) return uploadFromUrl(request, env, fetcher);
  throw new AppError(415, "Use multipart/form-data or application/json");
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
