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
      >
        {copied ? "Copied" : "Copy"}
      </button>
      {onEdit && (
        <button
          type="button"
          className="msg-action"
          onClick={onEdit}
          aria-label="Edit message: load text into composer"
        >
          Edit
        </button>
      )}
      {onRewind && (
        <button
          type="button"
          className="msg-action"
          onClick={onRewind}
          aria-label="Rewind to this message"
        >
          Rewind
        </button>
      )}
    </div>
  );
}
