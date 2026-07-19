/// Pure decision logic behind the composer's reasoning-effort dropdown, extracted
/// from App.tsx so the "should it show, and with what options" rule is testable
/// without a DOM. The picker appears only when Grok both advertised the effort
/// slash-command in this session AND the current model reports it supports
/// reasoning effort AND there is at least one level to choose from.
import type { SessionModelInfo } from "./bridge";

export interface EffortPickerModel {
  /// Whether the composer should render the dropdown at all.
  visible: boolean;
  /// The advertised levels (e.g. ["low","medium","high"]); empty when none.
  efforts: string[];
  /// The current level, if the session reported one.
  current?: string;
}

export function effortPickerModel(
  sessionInfo: SessionModelInfo | undefined,
  effortCommandAvailable: boolean,
): EffortPickerModel {
  const model = sessionInfo?.model;
  const efforts = model?.reasoningEfforts ?? [];
  const visible =
    Boolean(model?.supportsReasoningEffort) && effortCommandAvailable && efforts.length > 0;
  return { visible, efforts, current: model?.reasoningEffort };
}
