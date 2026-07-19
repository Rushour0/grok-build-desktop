import { describe, expect, it } from "vitest";

import { effortPickerModel } from "./effort";
import type { SessionModelInfo } from "./bridge";

const withModel = (model: SessionModelInfo["model"]): SessionModelInfo => ({ model });

describe("effortPickerModel", () => {
  it("is hidden when there is no session info", () => {
    expect(effortPickerModel(undefined, true)).toEqual({ visible: false, efforts: [], current: undefined });
  });

  it("is hidden when the model does not support reasoning effort", () => {
    const info = withModel({ supportsReasoningEffort: false, reasoningEfforts: ["low", "high"] });
    expect(effortPickerModel(info, true).visible).toBe(false);
  });

  it("is hidden when Grok never advertised the effort command", () => {
    const info = withModel({ supportsReasoningEffort: true, reasoningEfforts: ["low", "high"] });
    expect(effortPickerModel(info, false).visible).toBe(false);
  });

  it("is hidden when there are no levels to choose from", () => {
    const info = withModel({ supportsReasoningEffort: true, reasoningEfforts: [] });
    expect(effortPickerModel(info, true).visible).toBe(false);
    // ...and when the field is entirely absent
    expect(effortPickerModel(withModel({ supportsReasoningEffort: true }), true).visible).toBe(false);
  });

  it("is visible with levels + current when everything lines up", () => {
    const info = withModel({
      supportsReasoningEffort: true,
      reasoningEffort: "medium",
      reasoningEfforts: ["low", "medium", "high"],
    });
    expect(effortPickerModel(info, true)).toEqual({
      visible: true,
      efforts: ["low", "medium", "high"],
      current: "medium",
    });
  });

  it("stays visible without a current level (falls back to first in the UI)", () => {
    const info = withModel({ supportsReasoningEffort: true, reasoningEfforts: ["low", "high"] });
    const result = effortPickerModel(info, true);
    expect(result.visible).toBe(true);
    expect(result.current).toBeUndefined();
  });
});
