/// Small action row shown on a transcript bubble's hover/focus. Copies the
/// bubble's raw text to the clipboard (with a transient "Copied" confirmation)
/// and, for user ("you") messages, offers an "Edit" action that hands the text
/// back to the caller (App puts it back in the composer draft), plus an
/// optional "Rewind" action (also "you" bubbles) that asks the caller to open
/// the Rewind panel anchored at this message. This component never mutates
/// transcript history itself — it only reads `text` and reports user intent
/// via `onEdit`/`onRewind`.
import { useEffect, useRef, useState } from "react";

const COPIED_RESET_MS = 1200;

export function MessageActions({
  text,
  onEdit,
  onRewind,
}: {
  text: string;
  onEdit?: () => void;
  onRewind?: () => void;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);

  async function handleCopy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        return;
      }
    } catch {
      return;
    }
    setCopied(true);
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }

  return (
    <div className="msg-actions">
      <button
        type="button"
        className={"msg-action" + (copied ? " copied" : "")}
        onClick={handleCopy}
        aria-label={copied ? "Copied to clipboard" : "Copy message text"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {onEdit && (
        <button
          type="button"
          className="msg-action"
          onClick={onEdit}
          aria-label="Edit message: load text into composer"
          title="Edit"
        >
          <EditIcon />
        </button>
      )}
      {onRewind && (
        <button
          type="button"
          className="msg-action"
          onClick={onRewind}
          aria-label="Rewind to this message"
          title="Rewind"
        >
          <RewindIcon />
        </button>
      )}
    </div>
  );
}

/// Shared icon frame — 14px, stroke-based, inherits `currentColor` so the button's
/// hover/active colour drives it. `aria-hidden` because each button already has an
/// accessible name via `aria-label`.
function icon(children: React.ReactNode): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function CopyIcon(): React.ReactElement {
  return icon(
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>,
  );
}

function CheckIcon(): React.ReactElement {
  return icon(<path d="M20 6 9 17l-5-5" />);
}

function EditIcon(): React.ReactElement {
  return icon(
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>,
  );
}

function RewindIcon(): React.ReactElement {
  return icon(
    <>
      <path d="M3 7v6h6" />
      <path d="M3.5 13a9 9 0 1 0 2.1-9.4L3 7" />
    </>,
  );
}
