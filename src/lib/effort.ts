/// Pure decision logic behind the composer's reasoning-effort dropdown, extracted
/// from App.tsx so the "should it show, and with what options" rule is testable
/// without a DOM.
///
/// WHY this is not gated on `supportsReasoningEffort`: the real `grok-build` model
/// does not report that field (nor `reasoningEfforts`) in its session-info — see
/// `compat/default_models.json`. Gating on it made the dropdown permanently
/// invisible. The effort levels are a stable CLI convention (low/medium/high), so
/// we show the picker for any live session and fall back to those levels when the
/// model doesn't enumerate its own. Picking sends `/effort <level>`; if a given
/// build doesn't honor it, that's a no-op turn, not a broken UI.
import type { SessionModelInfo } from "./bridge";

/// The CLI's standard reasoning-effort levels, used when the session doesn't
/// enumerate its own in `model.reasoningEfforts`.
export const DEFAULT_EFFORTS: readonly string[] = ["low", "medium", "high"];

export interface EffortPickerModel {
  /// Whether the composer should render the dropdown at all.
  visible: boolean;
  /// The levels to offer — the session's own if it enumerated any, else the
  /// standard low/medium/high.
  efforts: string[];
  /// The current level, if the session reported one.
  current?: string;
}

/// `connected` is true once the tab has a live session (a session id) — that's the
/// point at which typing `/effort` into the composer is meaningful.
export function effortPickerModel(
  sessionInfo: SessionModelInfo | undefined,
  connected: boolean,
): EffortPickerModel {
  const model = sessionInfo?.model;
  const enumerated = model?.reasoningEfforts ?? [];
  const efforts = enumerated.length > 0 ? enumerated : [...DEFAULT_EFFORTS];
  return { visible: connected, efforts, current: model?.reasoningEffort };
}
