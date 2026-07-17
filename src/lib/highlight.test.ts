/// Tests for highlightToHtml (src/lib/highlight.ts).
///
/// The two things that MUST hold for every code path here, per the CSP guard in
/// tauri.conf.json (`style-src 'self'`, no `'unsafe-inline'`):
///   1. Known languages highlight into hljs-* class spans (not inline styles).
///   2. Unknown/missing languages never throw and fall back to escaped plaintext.
///   3. The returned html NEVER contains a `style=` attribute, on any path.
import { describe, expect, it } from "vitest";

import { highlightToHtml } from "./highlight";

describe("highlightToHtml", () => {
  it("highlights a known language (typescript) into hljs-* class spans", () => {
    const { html, language } = highlightToHtml(
      "const x: number = 42;\nfunction foo() { return x; }",
      "typescript",
    );
    expect(language).toBe("typescript");
    // Should contain at least one hljs-* class span (keyword, title/function, etc.)
    expect(html).toMatch(/class="hljs-[\w-]+"/);
    expect(html).toContain("<span");
  });

  it("resolves common aliases (ts) to the typescript grammar", () => {
    const { language } = highlightToHtml("let a = 1;", "ts");
    expect(language).toBe("typescript");
  });

  it("returns escaped plaintext for an unknown language without throwing", () => {
    expect(() => highlightToHtml("<script>alert(1)</script>", "not-a-real-language")).not.toThrow();
    const { html, language } = highlightToHtml("<script>alert(1)</script>", "not-a-real-language");
    expect(language).toBe("plaintext");
    // Raw HTML must be escaped, never passed through verbatim.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("returns escaped plaintext when no language hint is given", () => {
    const { html, language } = highlightToHtml("a < b && b > c");
    expect(language).toBe("plaintext");
    expect(html).toContain("&lt;");
    expect(html).toContain("&gt;");
  });

  it("never throws on pathological input", () => {
    expect(() => highlightToHtml("", "typescript")).not.toThrow();
    expect(() => highlightToHtml("\0\0\0", "rust")).not.toThrow();
    // @ts-expect-error deliberately passing a non-string to exercise the guard
    expect(() => highlightToHtml(null, "python")).not.toThrow();
  });

  // A real inline-style CSP violation looks like a `style="..."` HTML *attribute*
  // on an emitted tag: `<span style="...">`. Asserting `.not.toContain("style=")`
  // is too broad — these tests deliberately feed in source text that contains the
  // literal substring "style=" as CODE, not markup, and that substring survives
  // HTML-escaping (only `<`, `>`, `"` etc. get escaped, not the letters "style=").
  // So the guard here matches an actual unescaped tag-attribute occurrence, which
  // is the one shape that would ever slip past the CSP.
  const STYLE_ATTR = /<[a-zA-Z][^>]*\sstyle\s*=/;

  it("never emits an inline style= attribute (CSP guard), known language", () => {
    const { html } = highlightToHtml(
      "fn main() {\n  let v: Vec<i32> = vec![1, 2, 3];\n  println!(\"{:?}\", v);\n}",
      "rust",
    );
    expect(html).not.toMatch(STYLE_ATTR);
  });

  it("never emits an inline style= attribute (CSP guard), unknown language fallback", () => {
    const { html } = highlightToHtml('<div style="color:red">hi</div>', "totally-unknown");
    expect(html).not.toMatch(STYLE_ATTR);
  });

  it("never emits an inline style= attribute (CSP guard), across all curated languages", () => {
    const langs = [
      "typescript",
      "javascript",
      "rust",
      "python",
      "go",
      "json",
      "bash",
      "xml",
      "css",
      "markdown",
      "sql",
      "yaml",
      "toml",
      "diff",
      "plaintext",
    ];
    for (const lang of langs) {
      const { html } = highlightToHtml("sample code style=\"x\" content 123", lang);
      expect(html).not.toMatch(STYLE_ATTR);
    }
  });
});
