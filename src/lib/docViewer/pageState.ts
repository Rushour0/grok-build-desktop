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
