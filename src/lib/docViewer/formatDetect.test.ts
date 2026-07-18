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
});
