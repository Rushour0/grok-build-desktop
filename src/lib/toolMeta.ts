/// Parses the two shapes a tool call can arrive in — grok's non-standard
/// `_meta["x.ai/tool"]` block and plain ACP `title`/`kind` — into one `ToolFields`
/// shape that `ToolCard.tsx` renders and that both the replay reducer and the live
/// `onUpdate` path build from, so they can never drift from each other.
///
/// WHY loose parsing: `_meta["x.ai/tool"]` is not a contract grok promises to keep
/// stable — it's an implementation detail we're choosing to surface. A future grok
/// version adding, renaming, or omitting a field must degrade to a plain generic
/// card, never throw and break the transcript. Every read here is defensive:
/// unknown shapes fall through to `undefined`/`"unknown"` rather than throwing.
import type { SessionUpdate, ToolCallContent } from "./bridge";

export type ToolSource = "x.ai/tool" | "acp" | "unknown";

export interface ToolMeta {
  source: ToolSource;
  label?: string;
  semanticKind?: string;
  readOnly?: boolean;
  namespace?: string;
  canonicalInput?: unknown;
}

export interface ToolFields {
  title: string;
  status: string;
  meta: ToolMeta;
  rawInput?: unknown;
  rawOutput?: unknown;
  content: ToolCallContent[];
  locations: { path: string; line?: number }[];
}

/// Narrow an unknown value to a plain object we can safely probe with `in`/index
/// access, without TS complaining and without throwing on `null`/arrays/primitives.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/// Parse `_meta["x.ai/tool"]` LOOSELY: unknown or missing `kind`/`namespace` never
/// throw and never get clamped to a closed enum, because grok can introduce new
/// tool kinds at any time and a card for one of those must still render sensibly.
export function parseToolMeta(update: SessionUpdate): ToolMeta {
  const xaiRaw = asRecord(update._meta)?.["x.ai/tool"];
  const xai = asRecord(xaiRaw);

  if (xai) {
    // grok's own emitters have varied between snake_case and camelCase for these
    // two fields across versions — accept either rather than betting on one.
    const readOnly = xai.read_only !== undefined ? xai.read_only : xai.readOnly;
    const canonicalInput = xai.canonical_input !== undefined ? xai.canonical_input : xai.canonicalInput;
    return {
      source: "x.ai/tool",
      label: asString(xai.label),
      semanticKind: asString(xai.kind),
      readOnly: asBoolean(readOnly),
      namespace: asString(xai.namespace),
      canonicalInput,
    };
  }

  // No x.ai/tool meta (missing, or present-but-malformed like a string instead of
  // an object). Fall back to plain ACP: any kind/title at all still means a real
  // tool call, just not one grok decorated with its own metadata.
  if (update.kind !== undefined || update.title !== undefined) {
    return { source: "acp" };
  }

  return { source: "unknown" };
}

/// Read the tool-call content array off the wire. `SessionUpdate.content` stays
/// typed as the single message-chunk `ContentBlock` (see bridge.ts's doc comment),
/// but on `tool_call`/`tool_call_update` updates the wire actually sends an ARRAY
/// of the richer `ToolCallContent` shape — this cast is the one place that
/// mismatch is bridged, so nothing else in the app has to know about it.
export function toolContentOf(update: SessionUpdate): ToolCallContent[] {
  const raw = update.content as unknown;
  return Array.isArray(raw) ? (raw as ToolCallContent[]) : [];
}

/// Build initial `ToolFields` from a `tool_call` update. Replay has no live
/// concept of "in progress" vs "done" for the initial call itself, so a call that
/// arrives with no status of its own defaults to "completed" — a stored update
/// with an omitted status has already run its course.
export function toolFieldsFromCall(update: SessionUpdate): ToolFields {
  return {
    title: update.title ?? update.kind ?? "Working",
    status: update.status ?? "completed",
    meta: parseToolMeta(update),
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
    content: toolContentOf(update),
    locations: update.locations ?? [],
  };
}

/// Immutably merge a `tool_call_update` into existing `ToolFields`. Later updates
/// may ADD `canonicalInput`/`rawOutput`/`content`/`locations` that the initial
/// call didn't have yet — a field is only overwritten when the update actually
/// provides it, so a later update that's silent on a field can never wipe it out.
export function mergeToolUpdate(prev: ToolFields, update: SessionUpdate): ToolFields {
  const updateMeta = parseToolMeta(update);
  const mergedMeta: ToolMeta = {
    source: updateMeta.source !== "unknown" ? updateMeta.source : prev.meta.source,
    label: updateMeta.label ?? prev.meta.label,
    semanticKind: updateMeta.semanticKind ?? prev.meta.semanticKind,
    readOnly: updateMeta.readOnly ?? prev.meta.readOnly,
    namespace: updateMeta.namespace ?? prev.meta.namespace,
    canonicalInput: updateMeta.canonicalInput ?? prev.meta.canonicalInput,
  };

  const updateContent = toolContentOf(update);

  return {
    title: update.title ?? prev.title,
    status: update.status ?? prev.status,
    meta: mergedMeta,
    rawInput: update.rawInput ?? prev.rawInput,
    rawOutput: update.rawOutput ?? prev.rawOutput,
    content: updateContent.length > 0 ? updateContent : prev.content,
    locations: update.locations ?? prev.locations,
  };
}
