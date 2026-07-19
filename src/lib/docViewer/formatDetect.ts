export type DocFormat = "pdf" | "docx" | "doc" | "image" | "unsupported";

/// Raster image extensions the in-app viewer rasterizes to a canvas via
/// `createImageBitmap` (CSP-safe — no `data:`/`blob:` <img> load). SVG is
/// deliberately excluded: `createImageBitmap` support for SVG blobs is unreliable
/// across the macOS/Windows webviews, so `.svg` falls through to "unsupported".
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "ico"]);

export function detectDocFormat(path: string): DocFormat {
  const pathWithoutSuffix = path.split(/[?#]/, 1)[0];
  const extension = pathWithoutSuffix.slice(pathWithoutSuffix.lastIndexOf(".") + 1).toLowerCase();

  if (extension === "pdf" || extension === "docx" || extension === "doc") {
    return extension;
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }

  return "unsupported";
}
