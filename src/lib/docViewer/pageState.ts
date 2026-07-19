export const ZOOM_MIN: number = 0.25;
export const ZOOM_MAX: number = 4;
export const ZOOM_STEP: number = 0.25;

export function clampPage(page: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(page)) {
    return 1;
  }

  return Math.min(Math.max(Math.floor(page), 1), Math.floor(total));
}

export function clampZoom(zoom: number, min: number = ZOOM_MIN, max: number = ZOOM_MAX): number {
  if (Number.isNaN(zoom)) {
    return min;
  }

  return Math.min(Math.max(zoom, min), max);
}

export function zoomIn(zoom: number): number {
  return clampZoom(zoom + ZOOM_STEP);
}

export function zoomOut(zoom: number): number {
  return clampZoom(zoom - ZOOM_STEP);
}

/// Pixel dimensions for a canvas showing content of natural size (width×height)
/// at `scale`. Rounds to whole pixels and never returns a zero/negative dimension
/// (a 0×0 canvas throws in some engines), so a degenerate image or a tiny scale
/// still yields a paintable 1px-minimum surface.
export function scaledSize(
  width: number,
  height: number,
  scale: number,
): { width: number; height: number } {
  const safe = (value: number) =>
    Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
  return { width: safe(width * scale), height: safe(height * scale) };
}
