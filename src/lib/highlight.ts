/// Syntax highlighting for fenced code blocks in agent transcripts.
///
/// WHY highlight.js/lib/core + class-based output (not Shiki, not inline styles):
/// src-tauri/tauri.conf.json ships a strict CSP with `style-src 'self'` and NO
/// `'unsafe-inline'`. Shiki (and any highlighter that emits `style="color:#xyz"` per
/// token) would be silently dropped by the CSP or, worse, require weakening it — not
/// an option. highlight.js's default mode instead wraps tokens in `<span class="hljs-*">`
/// and leaves all coloring to a stylesheet we control (see App.css's hljs-* rules), which
/// is 100% compatible with a strict CSP: zero inline style attributes, zero inline <style>
/// tags generated from JS. We use `highlight.js/lib/core` (not the full `highlight.js`
/// bundle) and register only a curated language list below, so we do not ship megabytes
/// of grammars for languages this app will never render.
///
/// WHY this must never throw: the code being highlighted comes from an untrusted agent
/// (model output, tool diffs, file contents). A malformed fence, a language hint the
/// agent invented, or a highlight.js internal edge case must never crash the transcript
/// renderer. Every entry point here is wrapped so the worst case is a plain, escaped,
/// unhighlighted code block — never an exception bubbling into React.
///
/// WHY escaping matters even on the "no highlighting" path: this module's output is the
/// ONLY string in the app allowed into `dangerouslySetInnerHTML` (see CodeBlock.tsx). If
/// the fallback path forgot to HTML-escape, agent-controlled text could inject raw HTML.
/// `escapeHtml` below is used both by the unknown-language fallback and is relied on by
/// highlight.js itself for the "known language" path (hljs escapes text nodes internally).

import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini"; // also registers the "toml" alias
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/// Curated registration. Each language is registered once at module load under its
/// canonical hljs name; common aliases (js/ts/py/sh/yml/…) are added explicitly below
/// so fence-info-string variations like ```js or ```yml resolve correctly. Keeping this
/// list small keeps the highlighter fast and the bundle lean — extend it deliberately.
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", typescript); // TS grammar is a superset; good enough for JS/JSX/TSX fences
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("json", json);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("xml", xml); // covers html/xml/svg fences
hljs.registerLanguage("css", css);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("ini", ini); // registers "toml" as an alias too
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("plaintext", plaintext);

/// Map a fence-info-string language token (whatever an agent or markdown source wrote,
/// e.g. "ts", "js", "jsx", "tsx", "yml", "sh", "shell", "html", "htm") onto the hljs
/// registered-language name it should actually use. Anything not listed here is passed
/// straight through to `hljs.getLanguage`, which returns undefined for unknown names —
/// handled by the "unknown language" fallback in `highlightToHtml`.
const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  py3: "python",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  html: "xml",
  htm: "xml",
  svg: "xml",
  xhtml: "xml",
  md: "markdown",
  yml: "yaml",
  toml: "ini",
  text: "plaintext",
  txt: "plaintext",
  "": "plaintext",
};

/// Minimal HTML-escape helper. Used for the unknown-language / no-language fallback path,
/// and for the empty-input / error-recovery paths. Order matters: `&` must be escaped
/// first or the escape sequences for the other characters would themselves get mangled.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/// Resolve a fence-info-string language hint to a registered hljs language name, or
/// undefined if there is no match (including no hint at all).
function resolveLanguage(lang?: string): string | undefined {
  if (!lang) return undefined;
  const key = lang.trim().toLowerCase();
  const canonical = ALIASES[key] ?? key;
  return hljs.getLanguage(canonical) ? canonical : undefined;
}

/// Highlight `code` for display. Always returns class-based HTML (hljs-* spans, no inline
/// styles) suitable for the single sanctioned `dangerouslySetInnerHTML` use in the app
/// (see CodeBlock.tsx). Never throws:
///  - a recognized `lang` is highlighted with that grammar;
///  - an unrecognized/missing `lang` falls back to escaped plaintext (language "plaintext");
///  - any internal highlight.js failure is caught and also falls back to escaped plaintext.
/// `language` in the return value is the resolved language name actually used for
/// display (e.g. in the code block header), never the raw unresolved hint.
export function highlightToHtml(
  code: string,
  lang?: string,
): { html: string; language: string } {
  const safeCode = typeof code === "string" ? code : String(code ?? "");
  const resolved = resolveLanguage(lang);

  if (!resolved) {
    return { html: escapeHtml(safeCode), language: "plaintext" };
  }

  try {
    const result = hljs.highlight(safeCode, { language: resolved, ignoreIllegals: true });
    return { html: result.value, language: resolved };
  } catch {
    // highlight.js grammars can throw on pathological input; never let that reach React.
    return { html: escapeHtml(safeCode), language: "plaintext" };
  }
}
