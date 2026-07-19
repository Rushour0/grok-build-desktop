/// Renders a raster image (png/jpg/gif/webp/bmp/avif/ico) from raw bytes, with
/// zoom. CSP here is `img-src 'self'` with NO `data:`/`blob:`, so we can't load an
/// <img src="data:…">. Instead we decode the bytes with `createImageBitmap` (an
/// in-memory decode that is NOT an image-resource load, so it bypasses img-src
/// entirely) and paint the bitmap onto a <canvas> — the same canvas path pdf.js
/// uses. Animated GIFs show their first frame; EXIF orientation isn't applied
/// (acceptable for a v1 preview). SVG is routed to "unsupported" upstream.
import { useEffect, useRef, useState } from "react";

import { clampZoom, zoomIn, zoomOut, ZOOM_MAX, ZOOM_MIN } from "./lib/docViewer/pageState";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ImageRenderer({ data }: { data: Uint8Array }): React.ReactElement {
  const [scale, setScale] = useState(() => clampZoom(1));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dims, setDims] = useState<{ width: number; height: number } | null>(null);
  const bitmapRef = useRef<ImageBitmap | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Decode the bytes once per `data`. createImageBitmap does not go through the
  // CSP img-src check (it decodes an in-memory Blob, it doesn't load a URL).
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(null);
    setDims(null);
    if (bitmapRef.current) {
      bitmapRef.current.close();
      bitmapRef.current = null;
    }

    if (data.length === 0) {
      setLoading(false);
      setError("This image file is empty.");
      return;
    }

    // Copy into a fresh ArrayBuffer-backed view so the Blob owns contiguous bytes.
    const blob = new Blob([data]);
    createImageBitmap(blob)
      .then((bitmap) => {
        if (disposed) {
          bitmap.close();
          return;
        }
        bitmapRef.current = bitmap;
        setDims({ width: bitmap.width, height: bitmap.height });
        setLoading(false);
      })
      .catch((err) => {
        if (disposed) return;
        setError(`Couldn't decode this image: ${errorMessage(err)}`);
        setLoading(false);
      });

    return () => {
      disposed = true;
    };
  }, [data]);

  // Close the bitmap when the component goes away.
  useEffect(() => {
    return () => {
      if (bitmapRef.current) {
        bitmapRef.current.close();
        bitmapRef.current = null;
      }
    };
  }, []);

  // Paint (and repaint on zoom). Canvas pixel size follows the image × scale; CSS
  // caps it to the container width so large images scroll rather than overflow.
  useEffect(() => {
    const bitmap = bitmapRef.current;
    const canvas = canvasRef.current;
    if (!bitmap || !canvas || !dims) return;
    const width = Math.max(1, Math.round(dims.width * scale));
    const height = Math.max(1, Math.round(dims.height * scale));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setError("This webview can't paint a canvas.");
      return;
    }
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
  }, [dims, scale]);

  if (loading) {
    return <div className="docv-loading">Loading image…</div>;
  }
  if (error) {
    return <div className="docv-error">{error}</div>;
  }

  const percent = Math.round(scale * 100);

  return (
    <div className="docv-image">
      <div className="docv-pdf-toolbar">
        <button
          type="button"
          className="docv-zoom-btn"
          onClick={() => setScale((s) => zoomOut(s))}
          disabled={scale <= ZOOM_MIN}
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="docv-zoom">{percent}%</span>
        <button
          type="button"
          className="docv-zoom-btn"
          onClick={() => setScale((s) => zoomIn(s))}
          disabled={scale >= ZOOM_MAX}
          aria-label="Zoom in"
        >
          +
        </button>
        {dims && (
          <span className="docv-pageinfo">
            {dims.width} × {dims.height}
          </span>
        )}
      </div>
      <div className="docv-image-stage">
        <canvas ref={canvasRef} className="docv-image-canvas" />
      </div>
    </div>
  );
}
