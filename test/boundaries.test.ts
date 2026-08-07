import { describe, expect, it } from "vitest";
import { cleanFilename, expiresAtForSize } from "../src/services/files";
import {
  isPublicRemoteUrl,
  limitedStream,
  remoteFilename,
} from "../src/services/url-imports";

describe("retention boundaries", () => {
  const now = new Date("2026-08-07T00:00:00.000Z");

  it("keeps files below 50,000,000 bytes permanently", () => {
    expect(expiresAtForSize(0, now)).toBeNull();
    expect(expiresAtForSize(49_999_999, now)).toBeNull();
  });

  it("expires files at and above 50,000,000 bytes after seven days", () => {
    expect(expiresAtForSize(50_000_000, now)).toBe("2026-08-14T00:00:00.000Z");
    expect(expiresAtForSize(1_000_000_000, now)).toBe("2026-08-14T00:00:00.000Z");
  });

  it("removes path separators and control characters from names", () => {
    expect(cleanFilename("../bad\\name\u0000.txt")).toBe(".._bad_name.txt");
  });

  it("allows public HTTP URLs and rejects local or credentialed destinations", () => {
    expect(isPublicRemoteUrl("https://cdn.example.com/image.png")).toBe(true);
    expect(isPublicRemoteUrl("http://203.0.114.10/file.bin")).toBe(true);
    for (const url of [
      "file:///etc/passwd",
      "http://localhost/file",
      "http://127.0.0.1/file",
      "http://10.0.0.1/file",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/file",
      "http://[ff02::1]/file",
      "https://user:password@example.com/file",
    ]) expect(isPublicRemoteUrl(url)).toBe(false);
  });

  it("derives remote filenames in override, header, path order", () => {
    expect(remoteFilename(
      "https://example.com/download",
      "attachment; filename*=UTF-8''hello%20world.txt",
    )).toBe("hello world.txt");
    expect(remoteFilename("https://example.com/files/image.png", null)).toBe("image.png");
    expect(remoteFilename("https://example.com/files/image.png", null, "chosen.jpg")).toBe("chosen.jpg");
  });

  it("stops remote streams once their exact byte count crosses the limit", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      },
    });
    const limited = limitedStream(source, 3);
    const reader = limited.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
    await expect(reader.read()).rejects.toThrow("1,000,000,000 byte limit");
    expect(limited.limitExceeded()).toBe(true);
  });
});
