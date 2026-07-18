import { describe, expect, it } from "vitest";

import { checkSizeCap, MAX_PREVIEW_BYTES } from "./sizeGuard";

describe("checkSizeCap", () => {
  it("exports a 50MB default cap", () => {
    expect(MAX_PREVIEW_BYTES).toBe(50 * 1024 * 1024);
  });

  it("accepts a size below the cap", () => {
    expect(checkSizeCap(MAX_PREVIEW_BYTES - 1)).toEqual({ ok: true });
  });

  it("accepts a size exactly at the cap", () => {
    expect(checkSizeCap(MAX_PREVIEW_BYTES)).toEqual({ ok: true });
  });

  it("rejects a size over the cap with whole-MB details", () => {
    expect(checkSizeCap(82 * 1024 * 1024)).toEqual({
      ok: false,
      message: "This file is 82MB — too large to preview (cap is 50MB).",
    });
  });

  it("accepts zero bytes", () => {
    expect(checkSizeCap(0)).toEqual({ ok: true });
  });

  it("rejects unknown sizes", () => {
    expect(checkSizeCap(-1)).toEqual({ ok: false, message: "Unknown file size." });
    expect(checkSizeCap(Number.NaN)).toEqual({ ok: false, message: "Unknown file size." });
    expect(checkSizeCap(Number.POSITIVE_INFINITY)).toEqual({
      ok: false,
      message: "Unknown file size.",
    });
  });

  it("uses a custom cap when provided", () => {
    expect(checkSizeCap(2 * 1024 * 1024, 1 * 1024 * 1024)).toEqual({
      ok: false,
      message: "This file is 2MB — too large to preview (cap is 1MB).",
    });
  });
});
