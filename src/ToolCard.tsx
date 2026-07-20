/// One tool call in the transcript, rendered as a collapsible card. `ToolItem`
/// (see App.tsx) is built by `lib/toolMeta.ts`'s pure helpers for both the replay
/// reducer and the live `onUpdate` path, so this component never has to guess
/// which path produced the data it's rendering.
///
/// WHY unknown tools still render sensibly: `_meta["x.ai/tool"]` is an
/// implementation detail grok is free to change or omit. A tool with no meta at
/// all (`meta.source === "unknown"`) falls back to the plain ACP title and a
/// generic icon rather than rendering a blank or broken card.
import { useState } from "react";
import type { ToolItem } from "./App";
import { detectDocFormat } from "./lib/docViewer/formatDetect";
import { viewableAssetFrom } from "./lib/asset";

function prettyJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/// Plain text pulled out of a tool call's `content` array, joined for display in
/// the Output section. Non-text entries (diffs, nested content wrappers) are
/// skipped here — the card's job is a readable summary, not a full diff viewer.
function outputTextOf(item: ToolItem): string {
  const texts = item.content
    .map((c) => c.text ?? c.content?.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  if (texts.length > 0) return texts.join("\n");
  if (item.rawOutput !== undefined) return prettyJson(item.rawOutput);
  return "";
}

function durationOf(item: ToolItem): string | null {
  if (!item.startedAt || !item.endedAt) return null;
  return ((item.endedAt - item.startedAt) / 1000).toFixed(1) + "s";
}

export function ToolCard({
  item,
  onOpenDocument,
}: {
  item: ToolItem;
  /// Open a previewable file (pdf/docx) in the in-app viewer. When absent, file
  /// locations render as plain, non-clickable text (the default everywhere the
  /// viewer isn't wired).
  onOpenDocument?: (path: string) => void;
}): React.ReactElement {
  const failed = item.status === "failed";
  const [expanded, setExpanded] = useState(failed);

  const label = item.meta.label ?? item.title ?? "Working";
  const input = prettyJson(item.meta.canonicalInput ?? item.rawInput);
  const output = outputTextOf(item);
  const duration = durationOf(item);
  // A produced image / pdf / doc (from `locations` or, for image_gen, its result content) —
  // gets an explicit "View" button so it can be opened in the side viewer any time, not only
  // via the one-shot auto-open.
  const viewable = viewableAssetFrom(item.locations, item.content);
  const viewFmt = viewable ? detectDocFormat(viewable) : "unsupported";
  const viewLabel =
    viewFmt === "image"
      ? "View image"
      : viewFmt === "pdf"
        ? "View PDF"
        : viewFmt === "video"
          ? "View video"
          : "View document";

  return (
    <div className={"tool-card " + item.status + (expanded ? " expanded" : "") + (failed ? " failed" : "")}>
      <div className="tool-card-headrow">
        <button
          type="button"
          className="tool-card-head"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
        >
          <span className="tool-card-icon" data-kind={item.meta.semanticKind} />
          <span className="tool-card-label">{label}</span>
          {item.meta.readOnly && <span className="tool-card-ro">read-only</span>}
          <span className="tool-card-status" />
          {duration && <span className="tool-card-dur">{duration}</span>}
          <span className="tool-card-chevron" />
        </button>
        {viewable && onOpenDocument && (
          <button
            type="button"
            className="tool-card-view"
            onClick={() => onOpenDocument(viewable)}
            title="Open in the side viewer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            {viewLabel}
          </button>
        )}
      </div>
      {expanded && (
        <div className="tool-card-body">
          <div className="tool-card-section">
            <div className="tool-card-section-label">Input</div>
            <pre className="tool-card-pre">{input}</pre>
          </div>
          {output && (
            <div className="tool-card-section">
              <div className="tool-card-section-label">Output</div>
              <pre className="tool-card-pre">{output}</pre>
            </div>
          )}
          {item.locations.length > 0 && (
            <div className="tool-card-locs">
              {item.locations.map((l, i) => {
                const fmt = detectDocFormat(l.path);
                const openable = onOpenDocument && (fmt === "pdf" || fmt === "docx" || fmt === "image");
                return openable ? (
                  <button
                    type="button"
                    className="tool-loc tool-loc-open"
                    key={l.path + i}
                    onClick={() => onOpenDocument!(l.path)}
                    title="Open preview"
                  >
                    {l.path}
                    {l.line ? ":" + l.line : ""}
                  </button>
                ) : (
                  <span className="tool-loc" key={l.path + i}>
                    {l.path}
                    {l.line ? ":" + l.line : ""}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
