"use client";

import { drawAnnotation } from "./annotation-draw";
import { MARKUP_COLOR, type Annotation } from "./annotation-types";

/**
 * Generate an annotated PNG for an IMAGE source: the image with markup + ref
 * badges + comment callouts drawn on top, plus a summary strip appended below
 * listing every comment (so all comments are readable even if callouts overlap).
 * Sent as a normal `m.image` reply.
 *
 * Source bytes are pulled via a CORS fetch → object URL (same taint-avoidance as
 * annotation-flatten.ts) so the canvas is never tainted and `toBlob` works.
 */

const CALLOUT_BG = "#fff8dc";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = src;
  });
}

async function fetchObjectUrl(url: string): Promise<string> {
  const r = await fetch(url, { mode: "cors" });
  if (!r.ok) throw new Error(`fetch failed (${r.status})`);
  return URL.createObjectURL(await r.blob());
}

/** Word-wrap for canvas 2d text. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) line = candidate;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function measureCallout(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
  maxWidth: number,
): { width: number; height: number; lines: string[] } {
  const padX = 10;
  const padY = 8;
  const lineH = Math.round(fontSize * 1.3);
  const firstWord = text.split(/\s+/)[0] || text;
  const minW = Math.min(maxWidth, Math.max(72, ctx.measureText(firstWord).width + padX));
  let best = { width: maxWidth, height: maxWidth * 0.75, lines: wrapText(ctx, text, maxWidth - padX) };

  for (let w = minW; w <= maxWidth; w += 8) {
    const lines = wrapText(ctx, text, w - padX);
    const contentH = lines.length * lineH + padY;
    const h = w * 0.75;
    const widest = Math.max(...lines.map((ln) => ctx.measureText(ln).width), 0) + padX;
    if (contentH <= h && widest <= w) return { width: w, height: h, lines };
    best = { width: w, height: h, lines };
  }

  return best;
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob null"))), "image/png");
  });
}

export async function generateAnnotatedImage(opts: {
  url: string;
  annotations: Annotation[];
}): Promise<Blob> {
  const objUrl = await fetchObjectUrl(opts.url);
  try {
    const img = await loadImage(objUrl);
    const maxPx = 2000;
    const scale = Math.min(1, maxPx / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const W = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
    const H = Math.max(1, Math.round((img.naturalHeight || 1) * scale));

    // Pre-measure the summary strip so the canvas is sized correctly up front.
    const measure = document.createElement("canvas").getContext("2d")!;
    const fontSize = Math.max(13, Math.round(W * 0.011));
    const lineH = Math.round(fontSize * 1.35);
    const pad = Math.round(fontSize * 1.2);
    const stripInnerW = W - pad * 2;
    measure.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    let stripLines = 0;
    const blocks = opts.annotations.map((a) => {
      const header = `${a.refCode}: `;
      const lines = wrapText(measure, header + a.comment, stripInnerW);
      stripLines += lines.length;
      return { lines };
    });
    const stripH =
      opts.annotations.length > 0
        ? pad + lineH /*heading*/ + stripLines * lineH + blocks.length * 4 + pad
        : 0;

    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H + stripH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, W, H);

    // Markup + badges + comment callouts on the image.
    for (const a of opts.annotations) {
      drawAnnotation(ctx, a, W, H, false);
      drawCallout(ctx, a, W, H);
    }

    // Summary strip below the image.
    if (stripH > 0) {
      ctx.fillStyle = "#faf9f6";
      ctx.fillRect(0, H, W, stripH);
      ctx.fillStyle = opts.annotations[0]?.color || MARKUP_COLOR;
      ctx.fillRect(0, H, W, 2);
      let y = H + pad + fontSize;
      ctx.fillStyle = "#111111";
      ctx.font = `600 ${Math.round(fontSize * 1.15)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText("Annotations", pad, y);
      y += lineH;
      ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      for (const b of blocks) {
        for (const ln of b.lines) {
          ctx.fillStyle = "#222222";
          ctx.fillText(ln, pad, y);
          y += lineH;
        }
        y += 4;
      }
    }

    return await canvasToPngBlob(canvas);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

/** A small comment callout box near a markup's anchor. */
function drawCallout(ctx: CanvasRenderingContext2D, a: Annotation, W: number, H: number) {
  const g = a.geometry;
  const anchor =
    g.kind === "pen" ? (g.path[0] ?? { x: 0, y: 0 }) : { x: g.x, y: g.y };
  const fontSize = Math.max(12, Math.round(Math.min(W, H) * 0.014));
  ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  const callout = measureCallout(ctx, a.comment, fontSize, Math.min(W * 0.34, 240));
  const boxW = callout.width;
  const boxH = callout.height;
  const lines = callout.lines;
  const lineH = Math.round(fontSize * 1.3);
  let x = anchor.x * W + 8;
  if (x + boxW > W) x = Math.max(0, anchor.x * W - 8 - boxW);
  let y = anchor.y * H;
  if (y + boxH > H) y = Math.max(0, H - boxH);
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = CALLOUT_BG;
  ctx.fillRect(x, y, boxW, boxH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = a.color || MARKUP_COLOR;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, boxW, boxH);
  ctx.fillStyle = "#1a1a1a";
  lines.forEach((ln, i) => ctx.fillText(ln, x + 5, y + 4 + fontSize + i * lineH));
}
