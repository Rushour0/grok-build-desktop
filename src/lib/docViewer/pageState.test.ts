import { describe, expect, it } from "vitest";

import { clampPage, clampZoom, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, zoomIn, zoomOut } from "./pageState";

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
