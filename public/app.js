const DIRECT_UPLOAD_LIMIT = 100_000_000;
const MAX_FILE_SIZE = 1_000_000_000;
const PART_SIZE = 8 * 1024 * 1024;

const fileInput = document.querySelector("#file");
const chooseFiles = document.querySelector("#choose-files");
const dropZone = document.querySelector("#drop-zone");
const selectionStatus = document.querySelector("#selection-status");
const uploadList = document.querySelector("#upload-list");
const uploadCount = document.querySelector("#upload-count");
const uploadAllButton = document.querySelector("#upload-all");
const batchStatus = document.querySelector("#batch-status");
const uploadsSection = document.querySelector("#uploads");
const urlForm = document.querySelector("#url-form");
const urlInput = document.querySelector("#source-url");
const urlStatus = document.querySelector("#url-status");

const queue = new Map();
let batchBusy = false;

if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
  document.querySelector("#local-state").hidden = false;
}

function newQueueId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes) {
  if (bytes < 1_000) return `${bytes} ${bytes === 1 ? "Byte" : "Bytes"}`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1_000;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1_000; index += 1) {
    value /= 1_000;
    unit = units[index];
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision).replace(/\.0+$/u, "")} ${unit}`;
}

function displayExpiry(value) {
  return value ? new Date(value).toLocaleString() : "Never";
}

function itemName(item) {
  return item.kind === "url" ? item.url : item.file.name;
}

function itemMetadata(item) {
  return item.kind === "url"
    ? "Remote file · size and type checked during upload"
    : `${formatBytes(item.file.size)} · ${item.file.type || "application/octet-stream"}`;
}

async function responseJson(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Request failed with HTTP ${response.status}`);
  }
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}`);
  return body;
}

function resultDefinition(term, value) {
  const fragment = document.createDocumentFragment();
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  if (value instanceof Node) dd.append(value);
  else dd.textContent = value;
  fragment.append(dt, dd);
  return fragment;
}

function renderItem(item) {
  const row = document.createElement("li");
  row.className = `upload-item${item.state === "error" || item.state === "invalid" ? " is-error" : ""}${item.state === "complete" ? " is-complete" : ""}`;
  row.dataset.queueId = item.id;

  const summary = document.createElement("div");
  summary.className = "file-summary";
  const name = document.createElement("strong");
  name.className = "file-name";
  name.textContent = itemName(item);
  const metadata = document.createElement("span");
  metadata.className = "file-meta";
  metadata.textContent = itemMetadata(item);
  summary.append(name, metadata);

  const actions = document.createElement("div");
  actions.className = "item-actions";

  if (item.state !== "complete") {
    const upload = document.createElement("button");
    upload.type = "button";
    upload.className = "upload-one";
    upload.textContent = item.state === "error" ? "Retry" : item.state === "uploading" ? "Uploading…" : "Upload";
    upload.disabled = item.state === "uploading" || item.state === "invalid" || batchBusy;
    upload.addEventListener("click", () => { void uploadOne(item); });
    actions.append(upload);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = item.state === "complete" ? "dismiss-file" : "remove-file";
  remove.textContent = "×";
  remove.disabled = item.state === "uploading" || batchBusy;
  remove.setAttribute("aria-label", `${item.state === "complete" ? "Dismiss" : "Remove"} ${itemName(item)}`);
  remove.addEventListener("click", () => {
    queue.delete(item.id);
    renderQueue();
  });
  actions.append(remove);
  row.append(summary, actions);

  if (item.state === "uploading" || item.state === "error" || item.state === "invalid") {
    const detail = document.createElement("div");
    detail.className = "item-detail";
    const message = document.createElement("p");
    message.className = item.state === "error" || item.state === "invalid" ? "status error" : "status";
    message.setAttribute("role", "status");
    message.textContent = item.message;
    detail.append(message);
    if (item.state === "uploading") {
      const meter = document.createElement("progress");
      meter.max = 100;
      meter.setAttribute("aria-label", `Upload progress for ${itemName(item)}`);
      if (Number.isFinite(item.progress)) meter.value = item.progress;
      detail.append(meter);
    }
    row.append(detail);
  }

  if (item.state === "complete") {
    const detail = document.createElement("div");
    detail.className = "item-detail item-result";
    const dl = document.createElement("dl");
    const link = document.createElement("a");
    link.href = item.data.url;
    link.textContent = item.data.url;
    link.target = "_blank";
    link.rel = "noopener";
    const editPassword = document.createElement("code");
    editPassword.textContent = item.data.edit_password || "Shown when the upload was created";
    dl.append(
      resultDefinition("File URL", link),
      resultDefinition("Edit password", editPassword),
      resultDefinition("Expires", displayExpiry(item.data.data?.expires_at)),
    );
    detail.append(dl);
    row.append(detail);
  }

  return row;
}

function uploadableItems() {
  return [...queue.values()].filter((item) => item.state === "queued" || item.state === "error");
}

function renderQueue() {
  uploadsSection.hidden = queue.size === 0;
  uploadCount.textContent = String(queue.size);
  uploadList.replaceChildren(...[...queue.values()].map(renderItem));
  uploadAllButton.disabled = batchBusy || uploadableItems().length === 0;
}

function addFiles(files) {
  let added = 0;
  for (const file of files) {
    const invalid = file.size > MAX_FILE_SIZE;
    const id = newQueueId();
    queue.set(id, {
      id,
      kind: "file",
      file,
      state: invalid ? "invalid" : "queued",
      message: invalid ? "Files cannot exceed 1,000,000,000 bytes." : "",
      progress: null,
      data: null,
    });
    added += 1;
  }
  selectionStatus.classList.remove("error");
  selectionStatus.textContent = added === 1 ? "1 file added." : `${added} files added.`;
  renderQueue();
}

function addUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    urlStatus.classList.add("error");
    urlStatus.textContent = "Enter a valid URL.";
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    urlStatus.classList.add("error");
    urlStatus.textContent = "Use an HTTP or HTTPS URL.";
    return;
  }
  const id = newQueueId();
  queue.set(id, {
    id,
    kind: "url",
    url: url.toString(),
    state: "queued",
    message: "",
    progress: null,
    data: null,
  });
  urlInput.value = "";
  urlStatus.classList.remove("error");
  urlStatus.textContent = "1 URL added.";
  renderQueue();
}

async function directUpload(item) {
  const form = new FormData();
  form.append("file", item.file);
  return responseJson(await fetch("/api/files", { method: "POST", body: form }));
}

async function urlUpload(item) {
  return responseJson(await fetch("/api/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: item.url }),
  }));
}

async function uploadPartWithRetry(item, url, body, partNumber, partCount) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      item.message = attempt === 1
        ? `Uploading part ${partNumber} of ${partCount}…`
        : `Retrying part ${partNumber} of ${partCount} (${attempt}/3)…`;
      renderQueue();
      return await responseJson(await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      }));
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError;
}

async function multipartUpload(item) {
  const createBody = {
    filename: item.file.name,
    mime_type: item.file.type || "application/octet-stream",
    size: item.file.size,
  };
  const created = await responseJson(await fetch("/api/files/upload-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(createBody),
  }));

  const parts = [];
  const partCount = Math.ceil(item.file.size / PART_SIZE);
  try {
    for (let index = 0; index < partCount; index += 1) {
      const partNumber = index + 1;
      item.progress = Math.round((index / partCount) * 100);
      const body = item.file.slice(index * PART_SIZE, Math.min(item.file.size, (index + 1) * PART_SIZE));
      const uploaded = await uploadPartWithRetry(
        item,
        `/api/files/${encodeURIComponent(created.file_id)}/upload-part?uploadId=${encodeURIComponent(created.upload_id)}&partNumber=${partNumber}`,
        body,
        partNumber,
        partCount,
      );
      parts.push(uploaded);
    }
    item.message = "Finishing upload…";
    item.progress = 99;
    renderQueue();
    const completed = await responseJson(await fetch(
      `/api/files/${encodeURIComponent(created.file_id)}/complete?uploadId=${encodeURIComponent(created.upload_id)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    ));
    return { ...completed, edit_password: created.edit_password, url: created.url };
  } catch (error) {
    await fetch(
      `/api/files/${encodeURIComponent(created.file_id)}/abort?uploadId=${encodeURIComponent(created.upload_id)}`,
      { method: "DELETE" },
    ).catch(() => undefined);
    throw error;
  }
}

async function uploadOne(item) {
  if (item.state === "uploading" || item.state === "complete" || item.state === "invalid") return false;
  item.state = "uploading";
  item.message = item.kind === "url" ? "Cloning remote file…" : "Uploading…";
  item.progress = null;
  renderQueue();
  try {
    const data = item.kind === "url"
      ? await urlUpload(item)
      : item.file.size < DIRECT_UPLOAD_LIMIT
        ? await directUpload(item)
        : await multipartUpload(item);
    item.state = "complete";
    item.message = "Upload complete.";
    item.progress = 100;
    item.data = data;
    renderQueue();
    return true;
  } catch (error) {
    item.state = "error";
    item.message = error instanceof Error ? error.message : "Upload failed";
    item.progress = null;
    renderQueue();
    return false;
  }
}

async function uploadAll() {
  if (batchBusy) return;
  const items = uploadableItems();
  if (items.length === 0) return;
  batchBusy = true;
  batchStatus.classList.remove("error");
  batchStatus.textContent = `Uploading ${items.length} ${items.length === 1 ? "file" : "files"}…`;
  renderQueue();
  let completed = 0;
  for (const item of items) {
    if (await uploadOne(item)) completed += 1;
  }
  batchBusy = false;
  const failed = items.length - completed;
  batchStatus.textContent = failed === 0
    ? `${completed} ${completed === 1 ? "file" : "files"} uploaded.`
    : `${completed} uploaded, ${failed} failed.`;
  if (failed > 0) batchStatus.classList.add("error");
  renderQueue();
}

chooseFiles.addEventListener("click", (event) => {
  event.stopPropagation();
  fileInput.click();
});

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
  });
}

dropZone.addEventListener("drop", (event) => {
  if (event.dataTransfer?.files?.length) addFiles(event.dataTransfer.files);
});

fileInput.addEventListener("change", () => {
  if (fileInput.files?.length) addFiles(fileInput.files);
  fileInput.value = "";
});

urlForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addUrl(urlInput.value.trim());
});

uploadAllButton.addEventListener("click", () => { void uploadAll(); });

renderQueue();
