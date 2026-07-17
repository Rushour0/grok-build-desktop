/// Parses grok's non-standard `x.ai/session_notification` notification into a
/// dashboard-friendly `TaskItem`, and merges sightings of the same task/subagent
/// over time into a single row.
///
/// WHY loose parsing: the notification's tagged variant is UNVERIFIED headlessly —
/// we've never seen a live payload. Every read here is defensive: unknown tags,
/// missing fields, and non-object payloads all fall through to `null` rather than
/// throwing, so a future grok version adding/renaming/omitting a field degrades to
/// "notification ignored", never a crashed panel.
export interface TaskItem {
  id: string;
  kind: string;
  title: string;
  status: string;
  startedAt?: number;
  detail?: string;
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

/// Every tag that maps to a dashboard row, and the status it maps to. Tags NOT in
/// this table (monitor_event-adjacent oddities, future unknown tags, etc.) are
/// ignored by `parseNotify` — they never become a row, never throw.
const TAG_STATUS: Record<string, string> = {
  subagent_spawned: "running",
  subagent_progress: "running",
  subagent_finished: "completed",
  subagent_failed: "failed",
  task_backgrounded: "backgrounded",
  task_completed: "completed",
  task_failed: "failed",
  scheduled_task_created: "scheduled",
  scheduled_task_fired: "scheduled",
  scheduled_task_deleted: "scheduled",
  monitor_event: "monitoring",
};

/// A small counter used only to synthesize a stable-enough id when a payload gives
/// us a tag but no id of its own — better than dropping the notification.
let syntheticSeq = 0;

/// Pull a task-ish record from a raw x.ai/session_notification payload. Returns
/// null for non-task/unknown notifications (including malformed payloads).
export function parseNotify(payload: unknown): Omit<TaskItem, "startedAt"> | null {
  const rec = asRecord(payload);
  if (!rec) return null;

  // The tag field name is unverified — accept whichever of these three shows up.
  const tag = asString(rec.sessionUpdate) ?? asString(rec.type) ?? asString(rec.kind);
  if (!tag) return null;

  const status = TAG_STATUS[tag];
  if (!status) return null;

  const id =
    asString(rec.subagentId) ??
    asString(rec.taskId) ??
    asString(rec.id) ??
    `${tag}-${(syntheticSeq += 1)}`;

  const title =
    asString(rec.name) ??
    asString(rec.description) ??
    asString(rec.label) ??
    asString(rec.title) ??
    asString(rec.promptText) ??
    asString(rec.prompt) ??
    tag;

  const detail = asString(rec.detail) ?? asString(rec.message) ?? asString(rec.status) ?? undefined;

  return { id, kind: tag, title, status, detail };
}

/// Immutably merge a parsed record into an existing task list by id. First
/// sighting stamps `startedAt = now`; later sightings update kind/title/status/
/// detail without clobbering the original `startedAt`.
export function mergeTask(tasks: TaskItem[], rec: Omit<TaskItem, "startedAt">, now: number): TaskItem[] {
  const idx = tasks.findIndex((t) => t.id === rec.id);

  if (idx === -1) {
    return [...tasks, { ...rec, startedAt: now }];
  }

  const prev = tasks[idx];
  const merged: TaskItem = { ...prev, ...rec, startedAt: prev.startedAt };
  const next = tasks.slice();
  next[idx] = merged;
  return next;
}
