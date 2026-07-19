import { describe, expect, it } from "vitest";

import { clampPage, clampZoom, scaledSize, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, zoomIn, zoomOut } from "./pageState";

describe("scaledSize", () => {
  it("scales and rounds to whole pixels", () => {
    expect(scaledSize(100, 50, 1)).toEqual({ width: 100, height: 50 });
    expect(scaledSize(100, 50, 2)).toEqual({ width: 200, height: 100 });
    expect(scaledSize(101, 51, 0.5)).toEqual({ width: 51, height: 26 }); // 50.5→51, 25.5→26
  });

  it("never returns a zero, negative, or non-finite dimension", () => {
    expect(scaledSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
    expect(scaledSize(10, 10, 0)).toEqual({ width: 1, height: 1 });
    expect(scaledSize(10, 10, Number.NaN)).toEqual({ width: 1, height: 1 });
    expect(scaledSize(Number.POSITIVE_INFINITY, 10, 1)).toEqual({ width: 1, height: 10 });
  });
});

describe("clampPage", () => {
  it("clamps pages below and above the valid range", () => {
    expect(clampPage(0, 8)).toBe(1);
    expect(clampPage(9, 8)).toBe(8);
  });

  it("keeps pages within range", () => {
    expect(clampPage(4, 8)).toBe(4);
  });

  it("returns one when there are no pages or the input is invalid", () => {
    expect(clampPage(3, 0)).toBe(1);
    expect(clampPage(-2, 8)).toBe(1);
    expect(clampPage(Number.NaN, 8)).toBe(1);
  });

  it("floors fractional page numbers", () => {
    expect(clampPage(3.9, 8)).toBe(3);
  });
});

describe("clampZoom", () => {
  it("exports the preview zoom range and step", () => {
    expect({ ZOOM_MIN, ZOOM_MAX, ZOOM_STEP }).toEqual({
      ZOOM_MIN: 0.25,
      ZOOM_MAX: 4,
      ZOOM_STEP: 0.25,
    });
  });

  it("clamps zoom below and above the default range", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(5)).toBe(ZOOM_MAX);
  });

  it("keeps zoom within range", () => {
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("returns the minimum for NaN", () => {
    expect(clampZoom(Number.NaN)).toBe(ZOOM_MIN);
  });

  it("uses custom zoom bounds", () => {
    expect(clampZoom(3, 0.5, 2)).toBe(2);
    expect(clampZoom(Number.NaN, 0.5, 2)).toBe(0.5);
  });

  it("does not zoom in beyond the maximum", () => {
    expect(zoomIn(ZOOM_MAX)).toBe(ZOOM_MAX);
  });

  it("does not zoom out beyond the minimum", () => {
    expect(zoomOut(ZOOM_MIN)).toBe(ZOOM_MIN);
  });
});
