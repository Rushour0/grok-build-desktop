import { useEffect, useRef, useState } from "react";

import { DocxRenderer } from "./DocxRenderer";
import { PdfRenderer } from "./PdfRenderer";
import { ImageRenderer } from "./ImageRenderer";
import { readFilePreview } from "./lib/bridge";
import { detectDocFormat } from "./lib/docViewer/formatDetect";
import { checkSizeCap } from "./lib/docViewer/sizeGuard";

type ViewerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | { status: "ready"; bytes: Uint8Array; byteLength: number };

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function UnsupportedPreview(): React.ReactElement {
  return (
    <div className="overlay-empty">
      <span className="overlay-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v5h5" />
          <path d="M9 13h6M9 17h4" />
        </svg>
      </span>
      <p className="overlay-empty-title">Preview isn&apos;t supported for this file type yet</p>
      <p className="overlay-empty-hint">Open this file in your system app to view it.</p>
    </div>
  );
}

export function DocViewerPanel({
  path,
  cwd,
  onClose,
}: {
  path: string | null;
  cwd: string;
  onClose: () => void;
}): React.ReactElement | null {
  const [state, setState] = useState<ViewerState>({ status: "idle" });
  const activePath = useRef<string | null>(null);

  useEffect(() => {
    if (!path) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [path, onClose]);

  useEffect(() => {
    activePath.current = path;

    if (!path) {
      setState({ status: "idle" });
      return;
    }

    const requestedPath = path;
    setState({ status: "loading" });

    async function loadPreview(): Promise<void> {
      try {
        const res = await readFilePreview(requestedPath, cwd);
        if (activePath.current !== requestedPath) return;

        const size = checkSizeCap(res.byteLength);
        if (!size.ok) {
          setState({ status: "error", message: size.message });
          return;
        }

        if (res.byteLength === 0) {
          setState({ status: "empty" });
          return;
        }

        const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
        if (activePath.current === requestedPath) {
          setState({ status: "ready", bytes, byteLength: res.byteLength });
        }
      } catch (error) {
        if (activePath.current === requestedPath) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    void loadPreview();
  }, [path, cwd]);

  if (!path) return null;

  const format = detectDocFormat(path);
  let content: React.ReactElement;

  if (state.status === "loading" || state.status === "idle") {
    content = <div className="docv-loading">Loading document…</div>;
  } else if (state.status === "error") {
    content = <div className="docv-error">{state.message}</div>;
  } else if (state.status === "empty") {
    content = <div className="docv-loading">This file is empty.</div>;
  } else if (format === "pdf") {
    content = <PdfRenderer data={state.bytes} />;
  } else if (format === "docx") {
    content = <DocxRenderer data={state.bytes} />;
  } else if (format === "image") {
    content = <ImageRenderer data={state.bytes} />;
  } else {
    content = <UnsupportedPreview />;
  }

  return (
    <aside className="docviewer" aria-label="File preview">
      <div className="docviewer-head">
        <span className="docviewer-title" title={path}>
          {basename(path)}
        </span>
        <button
          type="button"
          className="docviewer-close"
          onClick={onClose}
          aria-label="Close preview"
          title="Close preview (Esc)"
        >
          ×
        </button>
      </div>
      <div className="docv-body">{content}</div>
    </aside>
  );
}
