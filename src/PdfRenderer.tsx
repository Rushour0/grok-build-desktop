import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

import { clampZoom, zoomIn, zoomOut, ZOOM_MAX, ZOOM_MIN } from "./lib/docViewer/pageState";

let workerConfigured = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function PdfRenderer({ data }: { data: Uint8Array }): React.ReactElement {
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(() => clampZoom(1));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentVersion, setDocumentVersion] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const pageElementsRef = useRef(new Map<number, HTMLDivElement>());
  const renderTasksRef = useRef(new Map<number, RenderTask>());
  const renderingPagesRef = useRef(new Map<number, number>());
  const renderGenerationRef = useRef(0);
  const currentPageRef = useRef(1);

  useEffect(() => {
    let disposed = false;
    let loadedDocument: PDFDocumentProxy | null = null;

    for (const task of renderTasksRef.current.values()) task.cancel();
    renderTasksRef.current.clear();
    renderingPagesRef.current.clear();
    documentRef.current = null;
    setNumPages(0);
    currentPageRef.current = 1;
    setCurrentPage(1);
    setLoading(true);
    setError(null);

    const loadDocument = async () => {
      try {
        if (data.byteLength === 0) throw new Error("The PDF file is empty.");

        const pdfjs = await import("pdfjs-dist");
        if (!workerConfigured) {
          pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
          workerConfigured = true;
        }

        const doc = await pdfjs.getDocument({ data }).promise;
        if (disposed) {
          void doc.destroy();
          return;
        }

        loadedDocument = doc;
        documentRef.current = doc;
        setNumPages(doc.numPages);
        setDocumentVersion((version) => version + 1);
        setLoading(false);
      } catch (caught) {
        if (!disposed) {
          setError(errorMessage(caught));
          setLoading(false);
        }
      }
    };

    void loadDocument();

    return () => {
      disposed = true;
      for (const task of renderTasksRef.current.values()) task.cancel();
      renderTasksRef.current.clear();
      renderingPagesRef.current.clear();
      if (documentRef.current === loadedDocument) documentRef.current = null;
      if (loadedDocument) void loadedDocument.destroy();
    };
  }, [data]);

  useEffect(() => {
    const doc = documentRef.current;
    if (!doc || numPages === 0) return;

    let disposed = false;
    const renderGeneration = renderGenerationRef.current + 1;
    renderGenerationRef.current = renderGeneration;
    const visiblePages = new Map<number, number>();
    for (const task of renderTasksRef.current.values()) task.cancel();
    renderTasksRef.current.clear();
    renderingPagesRef.current.clear();

    const renderPage = async (pageNumber: number, element: HTMLDivElement) => {
      if (disposed || renderingPagesRef.current.has(pageNumber)) return;
      renderingPagesRef.current.set(pageNumber, renderGeneration);
      let renderTask: RenderTask | null = null;

      try {
        const page = await doc.getPage(pageNumber);
        if (disposed || documentRef.current !== doc) return;

        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas rendering is unavailable.");

        canvas.className = "docv-pdf-canvas";
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        element.replaceChildren(canvas);

        renderTask = page.render({ canvasContext: context, viewport });
        renderTasksRef.current.set(pageNumber, renderTask);
        await renderTask.promise;
      } catch (caught) {
        if (!disposed && documentRef.current === doc && !(caught instanceof Error && caught.name === "RenderingCancelledException")) {
          setError(errorMessage(caught));
        }
      } finally {
        if (renderTasksRef.current.get(pageNumber) === renderTask) renderTasksRef.current.delete(pageNumber);
        if (renderingPagesRef.current.get(pageNumber) === renderGeneration) renderingPagesRef.current.delete(pageNumber);
      }
    };

    const updateCurrentPage = () => {
      let mostVisiblePage = currentPageRef.current;
      let highestRatio = -1;
      for (const [pageNumber, ratio] of visiblePages) {
        if (ratio > highestRatio) {
          mostVisiblePage = pageNumber;
          highestRatio = ratio;
        }
      }
      if (highestRatio >= 0) {
        currentPageRef.current = mostVisiblePage;
        setCurrentPage(mostVisiblePage);
      }
    };

    const observePage = (entries: IntersectionObserverEntry[]) => {
      for (const entry of entries) {
        const pageNumber = Number((entry.target as HTMLElement).dataset.pageNumber);
        if (!Number.isInteger(pageNumber)) continue;
        if (entry.isIntersecting) {
          visiblePages.set(pageNumber, entry.intersectionRatio);
          void renderPage(pageNumber, entry.target as HTMLDivElement);
        } else {
          visiblePages.delete(pageNumber);
        }
      }
      updateCurrentPage();
    };

    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(observePage, { root: pagesRef.current, rootMargin: "600px 0px" });

    for (const element of pageElementsRef.current.values()) {
      if (observer) observer.observe(element);
      else void renderPage(Number(element.dataset.pageNumber), element);
    }

    return () => {
      disposed = true;
      observer?.disconnect();
      for (const task of renderTasksRef.current.values()) task.cancel();
      renderTasksRef.current.clear();
      renderingPagesRef.current.clear();
    };
  }, [documentVersion, numPages, scale]);

  if (error) return <div className="docv-error">Couldn&apos;t render this PDF: {error}</div>;

  return (
    <div className="docv-pdf">
      <div className="docv-pdf-toolbar">
        <button
          type="button"
          className="docv-zoom-btn"
          onClick={() => setScale((value) => zoomOut(value))}
          disabled={scale <= ZOOM_MIN}
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="docv-zoom">{Math.round(scale * 100)}%</span>
        <button
          type="button"
          className="docv-zoom-btn"
          onClick={() => setScale((value) => zoomIn(value))}
          disabled={scale >= ZOOM_MAX}
          aria-label="Zoom in"
        >
          +
        </button>
        <span className="docv-pageinfo">Page {currentPage} / {numPages}</span>
      </div>
      <div className="docv-pdf-pages" ref={pagesRef} aria-busy={loading}>
        {Array.from({ length: numPages }, (_, index) => {
          const pageNumber = index + 1;
          return (
            <div
              key={pageNumber}
              className="docv-pdf-page"
              data-page-number={pageNumber}
              ref={(element) => {
                if (element) pageElementsRef.current.set(pageNumber, element);
                else pageElementsRef.current.delete(pageNumber);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
