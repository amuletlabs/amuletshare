import { describe, expect, it } from "vitest";
import { cleanFilename, expiresAtForSize } from "../src/services/files";

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
});
