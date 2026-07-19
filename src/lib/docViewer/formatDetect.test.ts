import { describe, expect, it } from "vitest";

import { detectDocFormat } from "./formatDetect";

describe("detectDocFormat", () => {
  it("detects supported document extensions", () => {
    expect(detectDocFormat("report.pdf")).toBe("pdf");
    expect(detectDocFormat("proposal.docx")).toBe("docx");
    expect(detectDocFormat("archive.doc")).toBe("doc");
  });

  it("detects extensions case-insensitively", () => {
    expect(detectDocFormat("FOO.PDF")).toBe("pdf");
    expect(detectDocFormat("LETTER.DoCx")).toBe("docx");
  });

  it("keeps legacy doc distinct from docx", () => {
    expect(detectDocFormat("legacy.doc")).toBe("doc");
    expect(detectDocFormat("modern.docx")).toBe("docx");
  });

  it("uses the extension after the last dot", () => {
    expect(detectDocFormat("/a.b/c.pdf")).toBe("pdf");
    expect(detectDocFormat("/a.pdf/c.docx")).toBe("docx");
  });

  it("rejects paths without a usable extension", () => {
    expect(detectDocFormat("README")).toBe("unsupported");
    expect(detectDocFormat("trailing.")).toBe("unsupported");
    expect(detectDocFormat("report.pdf?download=1")).toBe("pdf");
    expect(detectDocFormat("")).toBe("unsupported");
  });

  it("detects raster image extensions", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]) {
      expect(detectDocFormat(`shot.${ext}`)).toBe("image");
    }
  });

  it("detects image extensions case-insensitively and with suffixes", () => {
    expect(detectDocFormat("Diagram.PNG")).toBe("image");
    expect(detectDocFormat("/assets/icon.WEBP?v=2")).toBe("image");
  });

  it("treats svg as unsupported (createImageBitmap is unreliable for it)", () => {
    expect(detectDocFormat("logo.svg")).toBe("unsupported");
  });
});
