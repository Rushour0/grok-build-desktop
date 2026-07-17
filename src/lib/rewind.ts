/// Pure helpers for the Rewind feature — no React, no Tauri, no I/O. Everything
/// here takes plain values in and returns plain values out, so it can be
/// unit-tested directly and reused by both `RewindPanel.tsx` and `App.tsx`
/// without either of them re-deriving the same logic differently.
///
/// WHY defensive: the wire shape of `x.ai/rewind/points` is UNVERIFIED
/// headlessly (see HANDOFF.md). `normalizeRewindPoints` must accept whatever
/// grok actually sends — an array, a `{points:[...]}` wrapper, `null`,
/// `undefined`, or outright junk — and never throw. A malformed rewind
/// response must degrade to an empty list, not crash the transcript.
import type { RewindPoint } from "./bridge";

export type RewindMode = "conversation" | "files" | "both";

/// Narrow an unknown value to a plain object we can safely probe with `in`/
/// index access, without TS complaining and without throwing on `null`/
/// arrays/primitives. Mirrors the same helper in `toolMeta.ts`.
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/// A rewind point is "real" if it's a plain object — we don't require any
/// particular field to be present, since `RewindPoint` is all-optional and
/// grok's actual payload shape is unverified. Anything else (string, number,
/// array-inside-array, null) is dropped rather than coerced.
function isPlausiblePoint(value: unknown): value is RewindPoint {
  return asRecord(value) !== undefined;
}

/// Accepts the two documented wire shapes for `x.ai/rewind/points` —
/// a bare array of points, or `{ points: [...] }` — plus anything else
/// (`null`, `undefined`, a string, a number, an unrelated object) and always
/// returns an array. Never throws. Entries that aren't plausible objects are
/// filtered out rather than passed through, so downstream rendering code can
/// trust every element has at least the shape of a `RewindPoint`.
export function normalizeRewindPoints(raw: unknown): RewindPoint[] {
  let candidate: unknown = raw;

  // Unwrap the `{ points: [...] }` envelope shape.
  const record = asRecord(raw);
  if (record && Array.isArray(record.points)) {
    candidate = record.points;
  }

  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter(isPlausiblePoint);
}

/// A restore whose scope can touch on-disk files ("files" or "both") is
/// destructive: it overwrites work outside the app's own undo history and
/// cannot be undone. "conversation" only trims the transcript, which is safe
/// to reverse by picking a later point again.
export function isDestructiveMode(mode: RewindMode): boolean {
  return mode === "files" || mode === "both";
}

/// One honest sentence describing what a rewind will do, for the in-app
/// confirm step. Must degrade gracefully when the server didn't tell us
/// `fileChangeCount` or `promptText` — we'd rather say something true but
/// vague ("may restore files") than fabricate a specific count we don't have.
export function describeRewind(point: RewindPoint, mode: RewindMode): string {
  const hasFileCount =
    typeof point.fileChangeCount === "number" && Number.isFinite(point.fileChangeCount);
  const fileCount = hasFileCount ? (point.fileChangeCount as number) : undefined;

  const promptPreview =
    typeof point.promptText === "string" && point.promptText.trim().length > 0
      ? point.promptText.trim()
      : undefined;

  const target = promptPreview
    ? `the point at "${truncate(promptPreview, 60)}"`
    : "this point";

  const clauses: string[] = [];

  // Conversation-side effect: always happens for every mode, since restoring
  // any point removes the messages that came after it.
  clauses.push(`removes later messages in this conversation`);

  // File-side effect: only for "files"/"both", and only stated as a count
  // when we actually have one — otherwise say "may restore files" so we
  // never claim precision we don't have.
  if (mode === "files" || mode === "both") {
    clauses.push(
      hasFileCount
        ? `restores ${fileCount} file change${fileCount === 1 ? "" : "s"} on disk`
        : `may restore files on disk`
    );
  }

  const action = `Rewinding to ${target} ${joinClauses(clauses)}.`;
  const warning = isDestructiveMode(mode)
    ? " This can't be undone."
    : " Your files on disk won't be touched.";

  return action + warning;
}

/// Join 1-2 clauses into "does X" or "does X and Y" without an Oxford comma
/// edge case, since we only ever have at most two.
function joinClauses(clauses: string[]): string {
  if (clauses.length === 0) return "does nothing";
  if (clauses.length === 1) return clauses[0];
  return `${clauses[0]} and ${clauses[1]}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
