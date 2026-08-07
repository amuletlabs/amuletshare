import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const externalBaseUrl = process.env.SHARE_BASE_URL?.replace(/\/$/u, "");
const baseUrl = externalBaseUrl || "http://127.0.0.1:8787";
const startLocalWorker = !externalBaseUrl;
const runFullMultipart = process.env.SHARE_FULL_SMOKE !== "0";
const wranglerLog = process.env.WRANGLER_LOG_PATH || "/tmp/share-smoke-wrangler.log";
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "share-smoke-"));
const cleanupRequests = [];
let worker;
let workerOutput = "";

function rememberOutput(chunk) {
  workerOutput = `${workerOutput}${String(chunk)}`.slice(-16_000);
}

async function waitForHealthy() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The local Worker is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Worker did not become healthy.\n${workerOutput}`);
}

async function json(response) {
  const value = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function uploadFile(filePath, filename, options = {}) {
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.set("file", new File([bytes], filename, { type: options.mimeType || "application/octet-stream" }));
  if (options.password) form.set("password", options.password);
  if (options.editPassword) form.set("edit_password", options.editPassword);
  const response = await fetch(`${baseUrl}/api/files`, { method: "POST", body: form });
  const value = await json(response);
  cleanupRequests.push({ id: value.data.id, editPassword: value.edit_password });
  return { response, value };
}

async function deleteFile(id, editPassword) {
  return fetch(`${baseUrl}/api/files/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ edit_password: editPassword }),
  });
}

async function run() {
  if (startLocalWorker) {
    const migration = spawnSync(
      "pnpm",
      ["exec", "wrangler", "d1", "migrations", "apply", "share-db", "--local", "--persist-to", ".wrangler/state"],
      { cwd: project, encoding: "utf8", env: { ...process.env, WRANGLER_LOG_PATH: wranglerLog } },
    );
    if (migration.status !== 0) throw new Error(`Local migration failed:\n${migration.stdout}\n${migration.stderr}`);
    process.stdout.write(migration.stdout);

    worker = spawn(
      "pnpm",
      [
        "exec", "wrangler", "dev", "--local", "--persist-to", ".wrangler/state", "--port", "8787",
        "--var", "ENVIRONMENT:local", "--var", `BASE_URL:${baseUrl}`,
      ],
      { cwd: project, env: { ...process.env, WRANGLER_LOG_PATH: wranglerLog } },
    );
    worker.stdout.on("data", rememberOutput);
    worker.stderr.on("data", rememberOutput);
  }

  await waitForHealthy();
  console.log(`Smoke testing ${baseUrl}`);

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /share\.amulet\.so/u);

  const fixturePath = path.join(project, "test", "fixtures", "sample.txt");
  const protectedUpload = await uploadFile(fixturePath, "agent-note.txt", {
    mimeType: "text/plain",
    password: "view-one",
    editPassword: "manage-one",
  });
  assert.equal(protectedUpload.response.status, 201);
  assert.equal(protectedUpload.value.data.expires_at, null);
  assert.equal(protectedUpload.value.edit_password, "manage-one");
  assert.equal("object_key" in protectedUpload.value.data, false);
  const protectedId = protectedUpload.value.data.id;
  assert.equal((await fetch(`${baseUrl}/api/files/${protectedId}`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/files/${protectedId}?password=wrong`)).status, 403);
  const correctDownload = await fetch(`${baseUrl}/f/${protectedId}.txt?password=view-one`);
  assert.equal(correctDownload.status, 200);
  assert.match(await correctDownload.text(), /share smoke test/u);

  const patched = await fetch(`${baseUrl}/api/files/${protectedId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ edit_password: "manage-one", password: "view-two" }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await fetch(`${baseUrl}/api/files/${protectedId}?password=view-one`)).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/files/${protectedId}?password=view-two`)).status, 200);

  const disabledUrlImport = await fetch(`${baseUrl}/api/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/file.txt" }),
  });
  assert.equal(disabledUrlImport.status, 415);
  assert.deepEqual(await disabledUrlImport.json(), { error: "Use multipart/form-data" });

  const boundaryPath = path.join(temporaryDirectory, "retained-seven-days.bin");
  const boundaryFile = await open(boundaryPath, "w");
  await boundaryFile.truncate(50_000_000);
  await boundaryFile.close();
  const boundary = await uploadFile(boundaryPath, "retained-seven-days.bin");
  assert.equal(boundary.response.status, 201);
  assert.equal(typeof boundary.value.data.expires_at, "string");

  if (runFullMultipart) {
    const directLimitPath = path.join(temporaryDirectory, "direct-99999999.bin");
    const directLimitFile = await open(directLimitPath, "w");
    await directLimitFile.truncate(99_999_999);
    await directLimitFile.close();
    const directLimit = await uploadFile(directLimitPath, "direct-99999999.bin");
    assert.equal(directLimit.response.status, 201);
    assert.equal(directLimit.value.data.size_bytes, 99_999_999);
    assert.equal(typeof directLimit.value.data.expires_at, "string");
  }

  const abortCreate = await json(await fetch(`${baseUrl}/api/files/upload-url`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename: "abort.bin", size: 100_000_000 }),
  }));
  const aborted = await fetch(
    `${baseUrl}/api/files/${abortCreate.file_id}/abort?uploadId=${encodeURIComponent(abortCreate.upload_id)}`,
    { method: "DELETE" },
  );
  assert.equal(aborted.status, 200);

  if (runFullMultipart) {
    const multipartPath = path.join(temporaryDirectory, "multipart-100mb.bin");
    const multipartFile = await open(multipartPath, "w+");
    await multipartFile.truncate(100_000_000);
    const created = await json(await fetch(`${baseUrl}/api/files/upload-url`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "multipart-100mb.bin", size: 100_000_000, mime_type: "application/octet-stream" }),
    }));
    const parts = [];
    const partSize = 8 * 1024 * 1024;
    for (let position = 0, partNumber = 1; position < 100_000_000; position += partSize, partNumber += 1) {
      const length = Math.min(partSize, 100_000_000 - position);
      const chunk = Buffer.allocUnsafe(length);
      await multipartFile.read(chunk, 0, length, position);
      const uploaded = await json(await fetch(
        `${baseUrl}/api/files/${created.file_id}/upload-part?uploadId=${encodeURIComponent(created.upload_id)}&partNumber=${partNumber}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: chunk },
      ));
      parts.push(uploaded);
    }
    await multipartFile.close();
    const completedResponse = await fetch(
      `${baseUrl}/api/files/${created.file_id}/complete?uploadId=${encodeURIComponent(created.upload_id)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );
    const completed = await json(completedResponse);
    cleanupRequests.push({ id: completed.data.id, editPassword: created.edit_password });
    assert.equal(completed.data.size_bytes, 100_000_000);
    assert.equal(typeof completed.data.expires_at, "string");
    assert.equal("edit_password" in completed, false);
    const largeDownload = await fetch(`${baseUrl}/api/files/${completed.data.id}`);
    assert.equal(largeDownload.status, 200);
    assert.equal(largeDownload.headers.get("content-length"), "100000000");
    await largeDownload.body?.cancel();
  }

  if (startLocalWorker) {
    const inspector = await json(await fetch(`${baseUrl}/__local/data`));
    assert.ok(inspector.files.some((file) => file.id === protectedId && file.r2_exists));
  } else {
    assert.equal((await fetch(`${baseUrl}/__local`)).status, 404);
  }

  for (const entry of cleanupRequests.splice(0)) {
    const response = await deleteFile(entry.id, entry.editPassword);
    assert.equal(response.status, 200, `cleanup delete failed for ${entry.id}`);
  }
  assert.equal((await fetch(`${baseUrl}/api/files/${protectedId}`)).status, 404);
  console.log("Smoke test passed: UI, direct upload, disabled URL import, passwords, retention, multipart, abort, download, and deletion.");
}

try {
  await run();
} finally {
  for (const entry of cleanupRequests) {
    await deleteFile(entry.id, entry.editPassword).catch(() => undefined);
  }
  if (worker && worker.exitCode === null) worker.kill("SIGINT");
  await rm(temporaryDirectory, { recursive: true, force: true });
}
