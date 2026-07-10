import { drawAnnotation } from "./annotation-draw";
import type { Annotation } from "./annotation-types";
import { renderPdfPage } from "./pdf-render";

/**
 * Flatten one annotated page (image or PDF page) to a PNG blob: the page raster
 * with its markup + reference-code labels drawn on top, at export resolution.
 * This is what gets uploaded and attached to the chat so the silicon can *see*
 * exactly what was marked.
 *
 * Taint avoidance: the source bytes are pulled via a CORS `fetch` into a blob
 * and drawn from a same-origin object URL (or a same-origin data URL for PDF
 * pages), so the canvas is never tainted and `toBlob` works. Mirrors the
 * fetch-as-blob approach in `media-previewer.ts`'s `downloadAsset`.
 */

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

async function fetchAsObjectUrl(url: string): Promise<string> {
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error(`fetch failed (${r.status})`);
  const blob = await r.blob();
  return URL.createObjectURL(blob);
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
      "image/png",
    );
  });
}

export async function flattenAnnotatedPage(opts: {
  isPdf: boolean;
  /** Source attachment URL. */
  url: string;
  /** 0-based page index (always 0 for images). */
  page: number;
  /** Annotations for THIS page. */
  annotations: Annotation[];
  /** Longest side of the export, in px. */
  exportMaxPx?: number;
}): Promise<Blob> {
  const maxPx = opts.exportMaxPx ?? 2000;

  let img: HTMLImageElement;
  let revoke: string | null = null;
  if (opts.isPdf) {
    // Re-render the page at export resolution; the data URL is same-origin.
    const rendered = await renderPdfPage(opts.url, opts.page + 1, maxPx);
    img = await loadImage(rendered.dataUrl);
  } else {
    revoke = await fetchAsObjectUrl(opts.url);
    img = await loadImage(revoke);
  }

  try {
    // Fit within maxPx while preserving aspect (images can be huge).
    const natW = img.naturalWidth || 1;
    const natH = img.naturalHeight || 1;
    const scale = Math.min(1, maxPx / Math.max(natW, natH));
    const W = Math.max(1, Math.round(natW * scale));
    const H = Math.max(1, Math.round(natH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0, W, H);
    for (const a of opts.annotations) drawAnnotation(ctx, a, W, H, false);
    return await canvasToPngBlob(canvas);
  } finally {
    if (revoke) URL.revokeObjectURL(revoke);
  }
}

/** Unique 0-based page indices that have annotations, ascending. */
export function annotatedPages(annotations: Annotation[]): number[] {
  return [...new Set(annotations.map((a) => a.page))].sort((a, b) => a - b);
}
