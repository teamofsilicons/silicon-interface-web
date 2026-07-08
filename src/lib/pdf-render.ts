"use client";

/**
 * Render arbitrary PDF pages to PNG data URLs for the annotation studio.
 *
 * This generalizes `pdf-thumb.ts` (which only ever renders page 1 for the
 * attachment card): here we need any page, at a chosen resolution, and the page
 * count for navigation. The pdf.js worker setup is copied verbatim from
 * `pdf-thumb.ts` — `new URL(..., import.meta.url)` lets the bundler emit the
 * worker asset and hand us a usable URL at runtime (works in the prod build).
 *
 * Loaded documents are cached by URL so paging back and forth never reparses
 * the file. The flatten step (Milestone 5) re-renders at a higher scale through
 * the same `renderPdfPage`.
 */

type PdfjsModule = typeof import("pdfjs-dist");
type PDFDocumentProxy = Awaited<ReturnType<PdfjsModule["getDocument"]>["promise"]>;

let pdfjsPromise: Promise<PdfjsModule> | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

// One in-flight/loaded document per URL. pdf.js download URLs are stable for a
// session, so this keeps page navigation instant without refetching bytes.
const docCache = new Map<string, Promise<PDFDocumentProxy>>();

async function getDoc(url: string): Promise<PDFDocumentProxy> {
  let doc = docCache.get(url);
  if (!doc) {
    doc = loadPdfjs().then((pdfjs) => pdfjs.getDocument({ url }).promise);
    docCache.set(url, doc);
  }
  return doc;
}

/** Drop the cached pdf.js document for a URL, freeing worker-side resources. */
export async function releasePdfDocument(url: string): Promise<void> {
  const doc = docCache.get(url);
  if (!doc) return;
  docCache.delete(url);
  try {
    const loaded = await doc;
    loaded.cleanup();
    const destroy = (loaded as unknown as { destroy?: () => Promise<void> | void }).destroy;
    if (destroy) await destroy.call(loaded);
  } catch {
    // Best-effort cleanup only; a render may already have failed/cancelled.
  }
}

/** Number of pages in the PDF at `url` (documents are cached). */
export async function getPdfPageCount(url: string): Promise<number> {
  const doc = await getDoc(url);
  return doc.numPages;
}

export interface RenderedPdfPage {
  /** PNG data URL of the rendered page. */
  dataUrl: string;
  /** Intrinsic page size in PDF points (scale 1), for aspect / overlay sizing. */
  pageWidth: number;
  pageHeight: number;
}

/**
 * Render one page (1-based) to a PNG data URL.
 *
 * `maxPx` bounds the longest side so on-screen display stays light; the flatten
 * step passes a larger value for a crisp export. The returned intrinsic page
 * size (scale 1) lets callers reserve the right aspect before the image loads.
 */
export async function renderPdfPage(
  url: string,
  pageNumber: number,
  maxPx = 1600,
): Promise<RenderedPdfPage> {
  const doc = await getDoc(url);
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(maxPx / base.width, maxPx / base.height, 4);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  // White backing so transparent PDFs don't render on black.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const dataUrl = canvas.toDataURL("image/png");
    return { dataUrl, pageWidth: base.width, pageHeight: base.height };
  } finally {
    // Free the page's internal render resources; the doc stays cached.
    page.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }
}
