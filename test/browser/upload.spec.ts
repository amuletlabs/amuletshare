import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(directory, "..", "fixtures", name);
const pixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("previews browser-friendly files and sandboxes active content", async ({ page, request }) => {
  const createdIds: Array<{ id: string; editPassword: string }> = [];
  try {
    const imageUpload = await request.post("/api/files", {
      multipart: {
        file: { name: "pixel.png", mimeType: "image/png", buffer: pixelPng },
      },
    });
    expect(imageUpload.status()).toBe(201);
    const image = await imageUpload.json();
    createdIds.push({ id: image.data.id, editPassword: image.edit_password });

    const inlineResponse = await request.get(image.url);
    expect(inlineResponse.headers()["content-disposition"]).toMatch(/^inline;/u);
    expect(inlineResponse.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await inlineResponse.body()).toEqual(pixelPng);

    await page.goto(image.url);
    await expect(page.locator("img")).toHaveCount(1);
    await expect.poll(() => page.locator("img").evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);

    const forcedUrl = new URL(image.url);
    forcedUrl.searchParams.set("download", "1");
    const forcedResponse = await request.get(forcedUrl.toString());
    expect(forcedResponse.headers()["content-disposition"]).toMatch(/^attachment;/u);
    expect(forcedResponse.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await forcedResponse.body()).toEqual(pixelPng);

    const htmlUpload = await request.post("/api/files", {
      multipart: {
        file: {
          name: "unsafe.html",
          mimeType: "text/html",
          buffer: Buffer.from("<h1>Sandboxed HTML</h1><script>document.body.dataset.ran = 'yes'</script>"),
        },
      },
    });
    expect(htmlUpload.status()).toBe(201);
    const html = await htmlUpload.json();
    createdIds.push({ id: html.data.id, editPassword: html.edit_password });
    const htmlResponse = await request.get(html.url);
    expect(htmlResponse.headers()["content-disposition"]).toMatch(/^attachment;/u);
    expect(htmlResponse.headers()["x-content-type-options"]).toBe("nosniff");

    await page.goto(html.url);
    const htmlPreview = page.frameLocator('iframe[title="Preview of unsafe.html"]');
    await expect(htmlPreview.getByRole("heading", { name: "Sandboxed HTML" })).toBeVisible();
    await expect(htmlPreview.locator("body")).not.toHaveAttribute("data-ran", "yes");

    const markdownUpload = await request.post("/api/files", {
      multipart: {
        file: {
          name: "notes.md",
          mimeType: "application/octet-stream",
          buffer: Buffer.from("# Rendered Markdown\n\nA browser-friendly note.\n"),
        },
      },
    });
    expect(markdownUpload.status()).toBe(201);
    const markdown = await markdownUpload.json();
    createdIds.push({ id: markdown.data.id, editPassword: markdown.edit_password });

    await page.goto(markdown.url);
    await expect(page).toHaveTitle("notes.md — share.amulet.so");
    await expect(page.getByRole("link", { name: "Raw" })).toHaveAttribute("href", /raw=1/u);
    await expect(page.getByRole("link", { name: "Download" })).toHaveAttribute("href", /download=1/u);
    const markdownPreview = page.frameLocator('iframe[title="Preview of notes.md"]');
    await expect(markdownPreview.getByRole("heading", { name: "Rendered Markdown" })).toBeVisible();
  } finally {
    for (const file of createdIds) {
      await request.delete(`/api/files/${file.id}`, { data: { edit_password: file.editPassword } });
    }
  }
});

test("queues, individually uploads, and batch uploads through the landing page", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("share.amulet.so");
  await expect(page.getByRole("heading", { name: "share.amulet.so" })).toBeVisible();
  const limits = page.getByRole("region", { name: "Limits" });
  await expect(limits.getByRole("listitem")).toHaveCount(4);
  await expect(limits).toContainText("Up to 1 GB per file.");
  await expect(page.getByRole("link", { name: "llms.txt" })).toHaveAttribute("href", "/llms.txt");
  await expect(page.getByText("Agent?", { exact: false })).toContainText("upload via API");
  await expect(page.getByRole("link", { name: "YC" })).toHaveAttribute("href", "https://www.ycombinator.com/companies/amulet");
  await expect(page.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(llms.headers()["content-type"]).toContain("text/plain");
  expect(await llms.text()).toContain("Base URL: https://share.amulet.so");
  const docsPage = await page.context().newPage();
  await docsPage.goto("/llms.txt");
  await expect(docsPage).toHaveTitle("API — share.amulet.so");
  await expect(docsPage.getByRole("heading", { name: "share.amulet.so", exact: true })).toBeVisible();
  await expect(docsPage.getByRole("link", { name: "Raw text" })).toHaveAttribute("href", "/llms.txt?raw=1");
  await docsPage.goto("/terms");
  await expect(docsPage).toHaveTitle("Terms — share.amulet.so");
  await expect(docsPage.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
  await docsPage.close();
  await expect(page.getByLabel("Enable password")).toHaveCount(0);
  await expect(page.locator("#source-url")).toHaveCount(0);
  const disabledUrlImport = await request.post("/api/files", {
    headers: { "content-type": "application/json" },
    data: { url: "https://example.com/file.txt" },
  });
  expect(disabledUrlImport.status()).toBe(415);
  expect(await disabledUrlImport.json()).toEqual({ error: "Use multipart/form-data" });
  await expect(page.locator("#uploads")).toBeHidden();

  const fileInput = page.locator("#file");
  await fileInput.setInputFiles(fixture("sample.txt"));
  await fileInput.setInputFiles([fixture("sample-two.txt"), fixture("sample-three.txt")]);
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["share browser drag fixture\n"], "dropped.txt", { type: "text/plain" }));
    return transfer;
  });
  await page.dispatchEvent("#drop-zone", "drop", { dataTransfer });

  const rows = page.locator("#upload-list .upload-item");
  await expect(rows).toHaveCount(4);
  await expect(page.locator("#uploads")).toBeVisible();
  await expect(page.locator("#upload-count")).toHaveText("4");
  await expect(page.getByRole("button", { name: "Upload all" })).toBeEnabled();

  await rows.first().getByRole("button", { name: "Upload", exact: true }).click();
  await expect(rows.first().locator(".item-result")).toBeVisible();

  await page.getByRole("button", { name: "Upload all" }).click();
  await expect(page.locator("#batch-status")).toHaveText("3 files uploaded.");
  await expect(page.locator("#upload-list .item-result")).toHaveCount(4);

  const uploadedFiles = await page.locator("#upload-list .item-result").evaluateAll((results) =>
    results.map((result) => ({
      url: (result.querySelector("a") as HTMLAnchorElement).href,
      editPassword: result.querySelector("code")!.textContent!,
    })),
  );
  expect(uploadedFiles).toHaveLength(4);

  for (const uploaded of uploadedFiles) {
    const downloaded = await request.get(uploaded.url);
    expect(downloaded.status()).toBe(200);
    expect((await downloaded.body()).byteLength).toBeGreaterThan(0);
  }

  await page.getByRole("link", { name: "Inspect local state" }).click();
  await expect(page.getByRole("heading", { name: "Local state" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "sample.txt", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "sample-two.txt", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "sample-three.txt", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "dropped.txt", exact: true }).first()).toBeVisible();

  for (const uploaded of uploadedFiles) {
    const filename = new URL(uploaded.url).pathname.split("/").at(-1)!;
    const id = filename.split(".")[0];
    const deleted = await request.delete(`/api/files/${id}`, { data: { edit_password: uploaded.editPassword } });
    expect(deleted.status()).toBe(200);
  }
});
