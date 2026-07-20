/// Finding the viewable file a tool produced, shared by the transcript's auto-open logic
/// (App.tsx) and the tool card's "View" button (ToolCard.tsx). Kept here so neither imports
/// the other.
import { detectDocFormat } from "./docViewer/formatDetect";
import type { ToolCallContent } from "./bridge";

/// Whether a path is one the in-app side viewer can render (image / pdf / docx).
export function isViewablePath(path: string): boolean {
  const fmt = detectDocFormat(path);
  return fmt === "image" || fmt === "pdf" || fmt === "docx";
}

/// The viewable file (image / pdf / docx) a tool produced, from its `locations` OR its
/// result `content`. File-touching tools (write_file, edit, …) list files in `locations`;
/// image_gen carries NO `locations` and instead returns the saved file's absolute path in
/// its result content — a `path` field or a `{"path":"…"}` JSON blob. Returns the first
/// match, or null.
export function viewableAssetFrom(
  locations: { path: string }[] | undefined,
  content: ToolCallContent[] | undefined,
): string | null {
  for (const loc of locations ?? []) {
    if (isViewablePath(loc.path)) return loc.path;
  }
  for (const block of content ?? []) {
    if (block.path && isViewablePath(block.path)) return block.path;
    const text = block.content?.text ?? block.text;
    const match = text?.match(/"path"\s*:\s*"([^"]+)"/);
    if (match && isViewablePath(match[1])) return match[1];
  }
  return null;
}
