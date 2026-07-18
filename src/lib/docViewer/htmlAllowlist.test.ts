import { describe, expect, it } from "vitest";

import { ALLOWED_TAGS, allowedAttrs, isAllowedTag, sanitizeHref } from "./htmlAllowlist";

describe("htmlAllowlist", () => {
  it("contains the intended lowercase tags", () => {
    expect(ALLOWED_TAGS.has("p")).toBe(true);
    expect(ALLOWED_TAGS.has("table")).toBe(true);
    expect(ALLOWED_TAGS.has("a")).toBe(true);
    expect(ALLOWED_TAGS.has("script")).toBe(false);
  });

  it("accepts allowlisted tags case-insensitively", () => {
    expect(isAllowedTag("p")).toBe(true);
    expect(isAllowedTag("H1")).toBe(true);
    expect(isAllowedTag("TABLE")).toBe(true);
  });

  it("default-denies unknown and unsafe tags", () => {
    expect(isAllowedTag("")).toBe(false);
    expect(isAllowedTag("SCRIPT")).toBe(false);
    expect(isAllowedTag("img")).toBe(false);
    expect(isAllowedTag("iframe")).toBe(false);
  });

  it("keeps http and https links", () => {
    expect(sanitizeHref("http://example.com")).toBe("http://example.com");
    expect(sanitizeHref("https://example.com/path")).toBe("https://example.com/path");
    expect(sanitizeHref("HTTP://EXAMPLE.COM")).toBe("HTTP://EXAMPLE.COM");
  });

  it("rejects unsafe and non-web links", () => {
    expect(sanitizeHref("javascript:alert(1)")).toBeNull();
    expect(sanitizeHref("data:text/html,evil")).toBeNull();
    expect(sanitizeHref("mailto:test@example.com")).toBeNull();
    expect(sanitizeHref("/relative/path")).toBeNull();
    expect(sanitizeHref("")).toBeNull();
    expect(sanitizeHref(null)).toBeNull();
    expect(sanitizeHref(undefined)).toBeNull();
  });

  it("rejects control-character href tricks", () => {
    expect(sanitizeHref("https://evil\njavascript:")).toBeNull();
  });

  it("allows only the required attributes for each tag", () => {
    expect(allowedAttrs("a")).toEqual(["href"]);
    expect(allowedAttrs("td")).toEqual(["colspan", "rowspan"]);
    expect(allowedAttrs("TH")).toEqual(["colspan", "rowspan"]);
    expect(allowedAttrs("p")).toEqual([]);
    expect(allowedAttrs("unknown")).toEqual([]);
  });
});
