/// Turns a tab's `Item[]` transcript into a single shareable Markdown document —
/// the "execution receipt". Pure and deterministic: same items in, same string
/// out, every time, and it must never throw — a broken receipt would otherwise
/// take down the panel that renders it. Any item shape we don't recognize is
/// rendered as best-effort JSON rather than skipped or thrown on, because the
/// whole point of a receipt is to not lose anything edit-worthy.
import type { Item, ToolItem } from "../App";
import type { SessionModelInfo } from "./bridge";

export interface ReceiptMeta {
  title?: string;
  cwd?: string | null;
  model?: SessionModelInfo;
  generatedAt?: string;
}

/// Same text-extraction idea as ToolCard's `outputTextOf`, duplicated here on
/// purpose: that one is a React-adjacent helper living beside a component,
/// this one must stay pure and import nothing from the component tree.
function toolOutputText(item: ToolItem): string {
  const texts = item.content
    .map((c) => c.text ?? c.content?.text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  if (texts.length > 0) return texts.join("\n");
  if (item.rawOutput !== undefined) {
    try {
      return JSON.stringify(item.rawOutput, null, 2);
    } catch {
      return String(item.rawOutput);
    }
  }
  return "";
}

/// A fenced fake-diff block built straight from before/after text, since
/// `{type:"diff"}` content carries `oldText`/`newText` rather than a unified
/// diff string. Line-prefixed `-`/`+` so it reads like a diff without needing
/// a diff library in a pure module.
function diffBlock(path: string | undefined, oldText: string | undefined, newText: string | undefined): string {
  const header = path ? `--- ${path}\n+++ ${path}` : "--- before\n+++ after";
  const oldLines = (oldText ?? "").split("\n").map((l) => `-${l}`);
  const newLines = (newText ?? "").split("\n").map((l) => `+${l}`);
  const body = [...oldLines, ...newLines].join("\n");
  return "```diff\n" + header + "\n" + body + "\n```";
}

function durationOf(item: ToolItem): string | null {
  if (!item.startedAt || !item.endedAt) return null;
  return ((item.endedAt - item.startedAt) / 1000).toFixed(1) + "s";
}

function statusGlyph(status: string | undefined): string {
  if (status === "failed") return "✖"; // ✖
  if (status === "completed") return "✔"; // ✔
  return "○"; // ○ — pending/in-progress/unknown
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderTool(item: ToolItem): string[] {
  const lines: string[] = [];
  const label = item.meta?.label || item.title || "Tool call";
  const readOnlyTag = item.meta?.readOnly ? " (read-only)" : "";
  const duration = durationOf(item);
  const durationTag = duration ? ` — ${duration}` : "";
  lines.push(`${statusGlyph(item.status)} **${label}**${readOnlyTag} — ${item.status ?? "unknown"}${durationTag}`);

  for (const loc of item.locations ?? []) {
    lines.push(`  - \`${loc.path}${loc.line !== undefined ? `:${loc.line}` : ""}\``);
  }

  for (const c of item.content ?? []) {
    if (c.type === "diff") {
      lines.push("");
      lines.push(diffBlock(c.path, c.oldText, c.newText));
    } else if (c.type === "command" && c.text) {
      lines.push("");
      lines.push("```sh\n" + c.text + "\n```");
    }
  }

  const output = toolOutputText(item);
  if (output.trim().length > 0) {
    lines.push("");
    lines.push("```\n" + output + "\n```");
  }

  return lines;
}

/// Render a full run as Markdown. Deterministic, pure, never throws. Sections:
/// a header (title/cwd/model/effort), then the transcript in order.
export function itemsToMarkdown(items: Item[], meta?: ReceiptMeta): string {
  try {
    const out: string[] = [];
    const title = meta?.title?.trim() || "Grok run";
    out.push(`# ${title}`);
    out.push("");

    const headerLines: string[] = [];
    if (meta?.cwd) headerLines.push(`- **Directory:** \`${meta.cwd}\``);
    const modelName = meta?.model?.model?.name ?? meta?.model?.currentModelId;
    if (modelName) {
      const effort = meta?.model?.model?.reasoningEffort;
      headerLines.push(`- **Model:** ${modelName}${effort ? ` (effort: ${effort})` : ""}`);
    }
    headerLines.push(`- **Generated:** ${meta?.generatedAt ?? new Date().toISOString()}`);
    out.push(...headerLines);
    out.push("");

    if (!items || items.length === 0) {
      out.push("_No items in this conversation yet._");
      return out.join("\n").trimEnd() + "\n";
    }

    out.push("---");
    out.push("");

    for (const item of items) {
      try {
        if (item == null || typeof item !== "object" || !("kind" in item)) continue;

        switch (item.kind) {
          case "you": {
            out.push("### You");
            out.push("");
            out.push("> " + (item.text || "").split("\n").join("\n> "));
            out.push("");
            break;
          }
          case "answer": {
            out.push("### Grok");
            out.push("");
            out.push(item.text || "");
            out.push("");
            break;
          }
          case "thought": {
            out.push("<details><summary>Thinking</summary>");
            out.push("");
            out.push(item.text || "");
            out.push("");
            out.push("</details>");
            out.push("");
            break;
          }
          case "error": {
            out.push(`**Error:** ${item.text || ""}`);
            out.push("");
            break;
          }
          case "tool": {
            out.push(...renderTool(item));
            out.push("");
            break;
          }
          case "ask": {
            const toolTitle = item.req?.toolCall?.title ?? "Permission request";
            out.push(`**Approval requested:** ${toolTitle}`);
            if (item.decided) {
              out.push(`- Decision: ${item.decided}`);
            } else if (item.failed) {
              out.push(`- Decision failed: ${item.failed}`);
            } else {
              out.push("- Decision: _pending_");
            }
            for (const c of item.req?.toolCall?.content ?? []) {
              if (c.type === "diff") {
                out.push("");
                out.push(diffBlock(c.path, c.oldText, c.newText));
              }
            }
            out.push("");
            break;
          }
          case "plan": {
            out.push("### Plan");
            out.push("");
            for (const entry of item.entries ?? []) {
              const status = entry.status ?? "pending";
              const box = status === "completed" ? "[x]" : status === "in_progress" ? "[~]" : "[ ]";
              const priority = entry.priority ? ` _(${entry.priority})_` : "";
              out.push(`- ${box} ${entry.content}${priority}`);
            }
            out.push("");
            break;
          }
          case "usage": {
            const breakdown = [
              typeof item.inputTokens === "number" ? `${item.inputTokens.toLocaleString()} in` : null,
              typeof item.outputTokens === "number" ? `${item.outputTokens.toLocaleString()} out` : null,
              typeof item.reasoningTokens === "number" ? `${item.reasoningTokens.toLocaleString()} reasoning` : null,
              typeof item.cachedReadTokens === "number" ? `${item.cachedReadTokens.toLocaleString()} cached` : null,
            ].filter((p): p is string => p !== null);
            const total = typeof item.totalTokens === "number" ? `${item.totalTokens.toLocaleString()} tokens` : null;
            const duration =
              typeof item.apiDurationMs === "number" ? `${(item.apiDurationMs / 1000).toFixed(1)}s` : null;
            const parts = [
              item.modelId,
              total ? `${total}${breakdown.length ? ` (${breakdown.join(" · ")})` : ""}` : breakdown.join(" · "),
              duration,
            ].filter((p): p is string => Boolean(p));
            out.push(`_Usage: ${parts.join(" · ") || "n/a"}_`);
            out.push("");
            break;
          }
          default: {
            out.push("```json");
            out.push(safeString(item));
            out.push("```");
            out.push("");
          }
        }
      } catch {
        out.push("_(one item failed to render)_");
        out.push("");
      }
    }

    return out.join("\n").trimEnd() + "\n";
  } catch {
    return "# Grok run\n\n_Receipt could not be generated._\n";
  }
}

/// A safe default filename like "grok-run-<slug-of-title>.md". Never throws;
/// falls back to a plain "grok-run.md" for an untitled or unsafe title.
export function receiptFilename(meta?: ReceiptMeta): string {
  try {
    const raw = meta?.title?.trim();
    if (!raw) return "grok-run.md";
    const slug = raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return slug ? `grok-run-${slug}.md` : "grok-run.md";
  } catch {
    return "grok-run.md";
  }
}
