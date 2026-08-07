import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(directory, "..", "fixtures", name);
const pixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("renders safe images inline and keeps unsafe content download-only", async ({ page, request }) => {
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
        file: { name: "unsafe.html", mimeType: "text/html", buffer: Buffer.from("<h1>unsafe</h1>") },
      },
    });
    expect(htmlUpload.status()).toBe(201);
    const html = await htmlUpload.json();
    createdIds.push({ id: html.data.id, editPassword: html.edit_password });
    const htmlResponse = await request.get(html.url);
    expect(htmlResponse.headers()["content-disposition"]).toMatch(/^attachment;/u);
    expect(htmlResponse.headers()["x-content-type-options"]).toBe("nosniff");
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
  await expect.poll(() => page.getByRole("link", { name: "YC" }).evaluate((link) => getComputedStyle(link).marginLeft)).toBe("0px");
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
  await expect(page.locator("#source-url")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add URL" })).toBeVisible();
  await expect(page.locator(".url-help")).toHaveCount(0);
  await expect(page.locator(".url-box")).toHaveCSS("border-top-style", "dashed");
  const fileUrlHelp = page.locator(".help-popover");
  await expect(fileUrlHelp.locator("p")).toBeHidden();
  await fileUrlHelp.locator("summary").click();
  await expect(fileUrlHelp.locator("p")).toContainText("Web pages are rejected");
  await fileUrlHelp.locator("summary").click();
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

test("queues direct URLs and renders clone success and rejection", async ({ page }) => {
  await page.route("**/api/files", async (route) => {
    const request = route.request();
    const value = request.postDataJSON() as { url: string };
    if (value.url.includes("web-page")) {
      await route.fulfill({
        status: 415,
        contentType: "application/json",
        body: JSON.stringify({ error: "URL points to a web page, not a file" }),
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "0123456789abcdef",
          file_name: "pixel.png",
          mime_type: "image/png",
          size_bytes: 68,
          expires_at: null,
          created_at: "2026-08-07T00:00:00.000Z",
          downloads: 0,
        },
        edit_password: "mock-edit-password",
        url: "http://127.0.0.1:8787/f/0123456789abcdef.png",
      }),
    });
  });

  await page.goto("/");
  const sourceUrl = page.locator("#source-url");
  await sourceUrl.fill("https://cdn.example.com/pixel.png");
  await page.getByRole("button", { name: "Add URL" }).click();
  await sourceUrl.fill("https://example.com/web-page");
  await page.getByRole("button", { name: "Add URL" }).click();

  const rows = page.locator("#upload-list .upload-item");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("https://cdn.example.com/pixel.png");
  await expect(rows.first()).toContainText("size and type checked during upload");

  await rows.first().getByRole("button", { name: "Upload", exact: true }).click();
  await expect(rows.first().locator(".item-result")).toContainText("0123456789abcdef.png");
  await expect(rows.first().locator(".item-result")).toContainText("mock-edit-password");

  await rows.nth(1).getByRole("button", { name: "Upload", exact: true }).click();
  await expect(rows.nth(1)).toContainText("URL points to a web page, not a file");
  await expect(rows.nth(1)).toHaveClass(/is-error/u);
});
