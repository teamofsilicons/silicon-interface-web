"use client";

import * as React from "react";

/**
 * Render the first page of a PDF to a PNG data URL, for a mini preview on the
 * attachment card before the user opens the full previewer. Results are cached
 * per cache-key (media_id) for the session so scrolling never re-renders.
 *
 * pdf.js is loaded lazily (dynamic import) so its ~hundreds-of-KB bundle only
 * ships to users who actually view a PDF attachment.
 */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((pdfjs) => {
      // The worker is bundled as an asset; new URL(..., import.meta.url) lets
      // the bundler emit it and hand us a usable URL at runtime.
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

async function render(url: string, maxPx: number): Promise<string | null> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ url });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(maxPx / base.width, maxPx / base.height, 3);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // White backing so transparent PDFs don't render on a black canvas.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    void task.destroy();
  }
}

export function getPdfThumbnail(
  url: string,
  cacheKey: string,
  maxPx = 320,
): Promise<string | null> {
  const key = cacheKey || url;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = render(url, maxPx)
    .then((data) => {
      if (data) cache.set(key, data);
      inflight.delete(key);
      return data;
    })
    .catch(() => {
      inflight.delete(key);
      return null;
    });
  inflight.set(key, p);
  return p;
}

/** Hook: returns the first-page data URL (or null until ready / on failure). */
export function usePdfThumbnail(
  url: string | null | undefined,
  cacheKey: string,
  enabled = true,
): string | null {
  const [thumb, setThumb] = React.useState<string | null>(() =>
    cacheKey ? cache.get(cacheKey) ?? null : null,
  );
  React.useEffect(() => {
    if (!enabled || !url) return;
    if (thumb) return;
    let alive = true;
    void getPdfThumbnail(url, cacheKey).then((data) => {
      if (alive && data) setThumb(data);
    });
    return () => {
      alive = false;
    };
  }, [url, cacheKey, enabled, thumb]);
  return thumb;
}
