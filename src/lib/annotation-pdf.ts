"use client";

import { drawAnnotation } from "./annotation-draw";
import { MARKUP_COLOR, annotationMarkups, type Annotation, type Geometry } from "./annotation-types";
import { annotatedPages } from "./annotation-flatten";
import { getPdfPageCount, renderPdfPage } from "./pdf-render";

/**
 * Generate an annotated PDF: a copy of the ORIGINAL PDF with markup + comments
 * drawn on top, sent to chat as a normal `m.file` reply so the silicon can both
 * *see* and *text-extract* the annotations.
 *
 * Default path is a VECTOR overlay via pdf-lib — it loads the original bytes and
 * draws vector markup + real (selectable) text on the existing pages, preserving
 * the document's own text. If pdf-lib can't load the source (encrypted / odd
 * PDF), we fall back to rasterizing each page (markup burned into an image) and
 * assembling those into a PDF, so attach never hard-fails.
 *
 * pdf-lib is dynamic-imported so its bundle only ships when someone attaches.
 */

type PdfLib = typeof import("pdf-lib");

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

function darkTextOn(fill: { r: number; g: number; b: number }): boolean {
  const luma = 0.2126 * fill.r + 0.7152 * fill.g + 0.0722 * fill.b;
  return luma > 0.58;
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error(`fetch failed (${r.status})`);
  return r.arrayBuffer();
}

/** "design.pdf" → "design_v2.pdf"; "design_v2.pdf" → "design_v3.pdf" (case-
 *  insensitive "v" suffix, defaults to v2 when no version is present). Input
 *  separator is flexible (`-`/`_`/space) but output always uses "_v" — the
 *  established convention for round-tripped files. */
function nextVersionedFilename(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const versioned = stem.match(/^(.*)[-_ ]v(\d+)$/i);
  if (versioned) {
    const next = parseInt(versioned[2], 10) + 1;
    return `${versioned[1]}_v${next}${ext}`;
  }
  return `${stem}_v2${ext}`;
}

/** Word-wrap `text` to lines that fit `maxWidth` at `size`. */
function wrapText(
  text: string,
  font: { widthOfTextAtSize: (t: string, s: number) => number },
  size: number,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function measureCallout(
  text: string,
  font: { widthOfTextAtSize: (t: string, s: number) => number },
  size: number,
  maxWidth: number,
): { width: number; height: number; lines: string[] } {
  const padX = 10;
  const padY = 8;
  const lineH = size * 1.3;
  const minW = Math.min(maxWidth, Math.max(64, font.widthOfTextAtSize(text.split(/\s+/)[0] || text, size) + padX));
  let best = { width: maxWidth, height: maxWidth * 0.75, lines: wrapText(text, font, size, maxWidth - padX) };

  for (let w = minW; w <= maxWidth; w += 8) {
    const lines = wrapText(text, font, size, w - padX);
    const contentH = lines.length * lineH + padY;
    const h = w * 0.75;
    const widest = Math.max(...lines.map((ln) => font.widthOfTextAtSize(ln, size)), 0) + padX;
    if (contentH <= h && widest <= w) return { width: w, height: h, lines };
    best = { width: w, height: h, lines };
  }

  return best;
}

/** Draw one markup shape on a pdf-lib page (PDF coords: origin bottom-left). */
function drawMarkup(
  page: import("pdf-lib").PDFPage,
  g: Geometry,
  W: number,
  H: number,
  color: import("pdf-lib").RGB,
) {
  const stroke = Math.max(1, Math.min(W, H) * 0.004);
  if (g.kind === "rect") {
    page.drawRectangle({
      x: g.x * W,
      y: (1 - (g.y + g.h)) * H, // flip: top-left(y) → bottom-left(y)
      width: g.w * W,
      height: g.h * H,
      borderColor: color,
      borderWidth: stroke,
      color,
      opacity: 0.12,
      borderOpacity: 1,
    });
  } else if (g.kind === "pen") {
    for (let i = 1; i < g.path.length; i++) {
      const a = g.path[i - 1];
      const b = g.path[i];
      page.drawLine({
        start: { x: a.x * W, y: (1 - a.y) * H },
        end: { x: b.x * W, y: (1 - b.y) * H },
        thickness: stroke,
        color,
      });
    }
  } else {
    const r = Math.max(4, Math.min(W, H) * 0.01);
    page.drawEllipse({ x: g.x * W, y: (1 - g.y) * H, xScale: r, yScale: r, color });
  }
}

/** Top-left-ish anchor of a geometry in normalized coords. */
function anchorOf(g: Geometry): { x: number; y: number } {
  if (g.kind === "rect") return { x: g.x, y: g.y };
  if (g.kind === "pin") return { x: g.x, y: g.y };
  return g.path[0] ?? { x: 0, y: 0 };
}

async function vectorOverlay(
  lib: PdfLib,
  bytes: ArrayBuffer,
  annotations: Annotation[],
  sourceFilename: string,
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = lib;
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const pages = pdf.getPages();

  for (const pageIdx of annotatedPages(annotations)) {
    const page = pages[pageIdx];
    if (!page) continue;
    const { width: W, height: H } = page.getSize();
    for (const a of annotations.filter((x) => x.page === pageIdx)) {
      const markups = annotationMarkups(a);
      for (const m of markups) {
        const c = hexToRgb(m.color || MARKUP_COLOR);
        drawMarkup(page, m.geometry, W, H, rgb(c.r, c.g, c.b));
      }

      // Ref-code badge above the markup anchor.
      const firstMarkup = markups[0];
      const markup = hexToRgb(firstMarkup.color || MARKUP_COLOR);
      const markupColor = rgb(markup.r, markup.g, markup.b);
      const anc = anchorOf(firstMarkup.geometry);
      const badgeSize = Math.max(8, Math.min(W, H) * 0.016);
      const padX = badgeSize * 0.4;
      const bw = bold.widthOfTextAtSize(a.refCode, badgeSize) + padX * 2;
      const bh = badgeSize + badgeSize * 0.5;
      const bx = Math.min(Math.max(0, anc.x * W), W - bw);
      let by = Math.min((1 - anc.y) * H + 2, H - bh);
      if (by < 0) by = 0;
      page.drawRectangle({ x: bx, y: by, width: bw, height: bh, color: markupColor });
      page.drawText(a.refCode, {
        x: bx + padX,
        y: by + bh * 0.28,
        size: badgeSize,
        font: bold,
        color: darkTextOn(markup) ? rgb(0.07, 0.07, 0.07) : rgb(1, 1, 1),
      });
      for (const m of markups.slice(1)) {
        const c = hexToRgb(m.color || MARKUP_COLOR);
        const color = rgb(c.r, c.g, c.b);
        const extraAnchor = anchorOf(m.geometry);
        const extraBw = bold.widthOfTextAtSize(a.refCode, badgeSize) + padX * 2;
        const extraBh = bh;
        const extraBx = Math.min(Math.max(0, extraAnchor.x * W), W - extraBw);
        let extraBy = Math.min((1 - extraAnchor.y) * H + 2, H - extraBh);
        if (extraBy < 0) extraBy = 0;
        page.drawRectangle({ x: extraBx, y: extraBy, width: extraBw, height: extraBh, color });
        page.drawText(a.refCode, {
          x: extraBx + padX,
          y: extraBy + extraBh * 0.28,
          size: badgeSize,
          font: bold,
          color: darkTextOn(c) ? rgb(0.07, 0.07, 0.07) : rgb(1, 1, 1),
        });
      }

      // Comment callout near the markup.
      const cSize = Math.max(8, Math.min(W, H) * 0.014);
      const maxW = Math.min(W * 0.34, 230);
      const callout = measureCallout(a.comment, font, cSize, maxW);
      const lines = callout.lines;
      const lineH = cSize * 1.3;
      const boxW = callout.width;
      const boxH = callout.height;
      // Prefer to the right of the badge; flip left if it would overflow.
      let cx = bx + bw + 6;
      if (cx + boxW > W) cx = Math.max(0, bx - 6 - boxW);
      let cy = Math.min(by, H - boxH);
      if (cy < 0) cy = 0;
      page.drawRectangle({
        x: cx,
        y: cy,
        width: boxW,
        height: boxH,
        color: rgb(1, 1, 0.86),
        borderColor: markupColor,
        borderWidth: 0.75,
        opacity: 0.92,
      });
      lines.forEach((ln, i) => {
        page.drawText(ln, {
          x: cx + 5,
          y: cy + boxH - 4 - cSize - i * lineH,
          size: cSize,
          font,
          color: rgb(0.1, 0.1, 0.1),
        });
      });
    }
  }

  addSummaryPages(lib, pdf, annotations, font, bold, italic, sourceFilename);
  return pdf.save();
}

/** Append one or more "Annotation Feedback" summary pages listing every ref
 *  code + full comment (so all comments are readable in one place, text-
 *  extractable), followed by a note asking for a version-incremented revision
 *  — with the feedback pages stripped out — once every point is addressed.
 *  Visible (not hidden) so it's picked up whether the silicon reads the PDF
 *  via vision or text extraction. */
function addSummaryPages(
  lib: PdfLib,
  pdf: import("pdf-lib").PDFDocument,
  annotations: Annotation[],
  font: import("pdf-lib").PDFFont,
  bold: import("pdf-lib").PDFFont,
  italic: import("pdf-lib").PDFFont,
  sourceFilename: string,
) {
  const { rgb } = lib;
  const PW = 612;
  const PH = 792;
  const margin = 54;
  const maxW = PW - margin * 2;
  let page = pdf.addPage([PW, PH]);
  let y = PH - margin;
  page.drawText("Annotation Feedback", { x: margin, y, size: 18, font: bold, color: rgb(0.1, 0.1, 0.1) });
  y -= 28;

  for (const a of annotations) {
    const header = `${a.refCode} · page ${a.page + 1}`;
    const lines = wrapText(a.comment, font, 11, maxW - 12);
    const blockH = 16 + lines.length * 15 + 10;
    if (y - blockH < margin) {
      page = pdf.addPage([PW, PH]);
      y = PH - margin;
    }
    page.drawText(header, { x: margin, y, size: 11, font: bold, color: rgb(0.1, 0.1, 0.1) });
    y -= 16;
    for (const ln of lines) {
      page.drawText(ln, { x: margin + 12, y, size: 11, font, color: rgb(0.15, 0.15, 0.15) });
      y -= 15;
    }
    y -= 10;
  }

  // A visible, clearly-labeled closing note for the agent handling this file —
  // not hidden text, so it's guaranteed to be picked up regardless of how the
  // PDF is read, and a human opening it understands what it's for.
  const nextName = nextVersionedFilename(sourceFilename);
  const note =
    `Once every point above is implemented, please send back an updated PDF — ` +
    `with this Annotation Feedback page and any additional feedback pages after that ` +
    `removed — named "${nextName}".`;
  const noteLines = wrapText(note, italic, 10, maxW - 12);
  const noteH = 14 + noteLines.length * 14 + 6;
  if (y - noteH < margin) {
    page = pdf.addPage([PW, PH]);
    y = PH - margin;
  }
  y -= 6;
  page.drawLine({
    start: { x: margin, y: y + 4 },
    end: { x: PW - margin, y: y + 4 },
    thickness: 0.5,
    color: rgb(0.75, 0.75, 0.75),
  });
  y -= 12;
  page.drawText("Note to the agent:", {
    x: margin,
    y,
    size: 10,
    font: bold,
    color: rgb(0.4, 0.4, 0.4),
  });
  y -= 14;
  for (const ln of noteLines) {
    page.drawText(ln, { x: margin, y, size: 10, font: italic, color: rgb(0.4, 0.4, 0.4) });
    y -= 14;
  }
}

/** Fallback: rasterize each annotated page to an image and assemble a PDF. */
async function rasterizeToPdf(
  lib: PdfLib,
  url: string,
  annotations: Annotation[],
  sourceFilename: string,
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = lib;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  // Preserve every source page. Rendering only `annotatedPages()` would make
  // the recovery path silently drop untouched pages from the exported PDF.
  const pageCount = await getPdfPageCount(url);
  for (let pageIdx = 0; pageIdx < pageCount; pageIdx += 1) {
    const rendered = await renderPdfPage(url, pageIdx + 1, 2000);
    const img = await loadImage(rendered.dataUrl);
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(img, 0, 0);
    for (const a of annotations.filter((x) => x.page === pageIdx)) {
      drawAnnotation(ctx, a, canvas.width, canvas.height, false);
    }
    const pngBytes = await canvasToPngBytes(canvas);
    const png = await pdf.embedPng(pngBytes);
    const page = pdf.addPage([png.width, png.height]);
    page.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
  }
  addSummaryPages(lib, pdf, annotations, font, bold, italic, sourceFilename);
  return pdf.save();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (!b) return reject(new Error("toBlob null"));
      b.arrayBuffer().then((ab) => resolve(new Uint8Array(ab)));
    }, "image/png");
  });
}

export async function generateAnnotatedPdf(opts: {
  url: string;
  annotations: Annotation[];
  /** The ORIGINAL attachment's filename — used for the closing note's
   *  suggested next-version filename. */
  sourceFilename: string;
}): Promise<Blob> {
  const lib = (await import("pdf-lib")) as PdfLib;
  const bytes = await fetchBytes(opts.url);
  let out: Uint8Array;
  try {
    out = await vectorOverlay(lib, bytes, opts.annotations, opts.sourceFilename);
  } catch {
    // Encrypted / unsupported original — burn markup into rasterized pages.
    out = await rasterizeToPdf(lib, opts.url, opts.annotations, opts.sourceFilename);
  }
  return new Blob([out as BlobPart], { type: "application/pdf" });
}
