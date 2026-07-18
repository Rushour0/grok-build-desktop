export const MAX_PREVIEW_BYTES: number = 50 * 1024 * 1024;

export function checkSizeCap(
  byteLength: number,
  cap: number = MAX_PREVIEW_BYTES,
): { ok: true } | { ok: false; message: string } {
  if (!Number.isFinite(byteLength) || byteLength < 0) {
    return { ok: false, message: "Unknown file size." };
  }

  if (byteLength > cap) {
    const fileSizeMb = Math.ceil(byteLength / (1024 * 1024));
    const capMb = Math.floor(cap / (1024 * 1024));

    return {
      ok: false,
      message: `This file is ${fileSizeMb}MB — too large to preview (cap is ${capMb}MB).`,
    };
  }

  return { ok: true };
}
