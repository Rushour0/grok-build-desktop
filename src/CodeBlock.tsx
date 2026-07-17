/// Fenced-code-block renderer for the transcript's markdown output.
///
/// WHY this exists as its own memoized component: markdown bubbles re-render whenever the
/// surrounding message stream updates (new chunks arrive constantly during a live turn).
/// Re-running highlight.js on every code fence on every chunk would be wasted work and
/// would also blow away transient UI state (the "Copied" flash, the wrap toggle) on each
/// render. Memoizing on {code, lang} means a code block is only re-highlighted when its
/// own content actually changes, not when a sibling bubble's text grows.
///
/// WHY dangerouslySetInnerHTML is safe here and only here: `highlightToHtml` (see
/// lib/highlight.ts) guarantees its output is either highlight.js's class-based markup
/// (which HTML-escapes token text internally) or an explicitly escaped plaintext fallback.
/// It never passes agent-controlled text through unescaped. This is the ONE sanctioned
/// dangerouslySetInnerHTML in the app for exactly that reason — do not add another one
/// for raw agent text elsewhere.
import { memo, useState } from "react";
import { highlightToHtml } from "./lib/highlight";

interface CodeBlockProps {
  code: string;
  lang?: string;
}

function CodeBlockImpl({ code, lang }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);

  const { html, language } = highlightToHtml(code, lang);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      // Transient confirmation only; not persisted, not announced beyond the button label.
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, non-secure context, etc.) — fail silently
      // rather than crashing the transcript renderer over a copy-to-clipboard nicety.
    }
  }

  return (
    <div className={`code-block${wrap ? " wrap" : ""}`}>
      <div className="code-block-head">
        <span className="code-lang">{language}</span>
        <button type="button" className="diff-tool" onClick={() => setWrap((w) => !w)} aria-pressed={wrap}>
          {wrap ? "No wrap" : "Wrap"}
        </button>
        <button type="button" className="code-copy" onClick={handleCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

export const CodeBlock = memo(CodeBlockImpl, (prev, next) => prev.code === next.code && prev.lang === next.lang);
