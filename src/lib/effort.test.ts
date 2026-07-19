import { describe, expect, it } from "vitest";

import { DEFAULT_EFFORTS, effortPickerModel } from "./effort";
import type { SessionModelInfo } from "./bridge";

const withModel = (model: SessionModelInfo["model"]): SessionModelInfo => ({ model });

describe("effortPickerModel", () => {
  it("is hidden until the tab has a live session", () => {
    expect(effortPickerModel(undefined, false)).toEqual({
      visible: false,
      efforts: [...DEFAULT_EFFORTS],
      current: undefined,
    });
  });

  it("is visible once connected, even when the model reports no effort fields", () => {
    // grok-build's real session-info has no supportsReasoningEffort/reasoningEfforts
    // (see compat/default_models.json) — the picker must still show.
    const result = effortPickerModel(undefined, true);
    expect(result.visible).toBe(true);
    expect(result.efforts).toEqual(["low", "medium", "high"]);
    expect(result.current).toBeUndefined();
  });

  it("falls back to standard levels when the session enumerates none", () => {
    const info = withModel({ name: "Grok Build", reasoningEfforts: [] });
    expect(effortPickerModel(info, true).efforts).toEqual(["low", "medium", "high"]);
  });

  it("prefers the session's own enumerated levels and current when present", () => {
    const info = withModel({
      supportsReasoningEffort: true,
      reasoningEffort: "medium",
      reasoningEfforts: ["low", "medium", "high", "max"],
    });
    expect(effortPickerModel(info, true)).toEqual({
      visible: true,
      efforts: ["low", "medium", "high", "max"],
      current: "medium",
    });
  });

  it("carries the current level through even with fallback levels", () => {
    const info = withModel({ reasoningEffort: "high" });
    const result = effortPickerModel(info, true);
    expect(result.efforts).toEqual(["low", "medium", "high"]);
    expect(result.current).toBe("high");
  });
});
