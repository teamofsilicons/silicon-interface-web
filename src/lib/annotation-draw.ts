import {
  MARKUP_COLOR,
  annotationMarkups,
  type Annotation,
  type Geometry,
  type NPoint,
} from "./annotation-types";

/**
 * Shared markup rendering, used by BOTH the live overlay (`overlay-canvas.tsx`)
 * and the flattened export (`annotation-flatten.ts`), so what the user draws is
 * exactly what gets attached to the chat.
 *
 * All sizes (stroke, pin, label) are proportional to the canvas's smaller side,
 * so markup keeps the same *relative* weight whether drawn on a ~600px on-screen
 * box or a ~2000px export — no hairlines on big exports, no clobbered small ones.
 */

function unit(W: number, H: number): number {
  return Math.min(W, H);
}
function strokeWidth(W: number, H: number, emphasized: boolean): number {
  const base = Math.max(2, unit(W, H) * 0.005);
  return emphasized ? base * 1.7 : base;
}
function pinRadius(W: number, H: number, emphasized: boolean): number {
  const r = Math.max(6, unit(W, H) * 0.013);
  return emphasized ? r * 1.25 : r;
}

export function readableTextColor(fill: string): string {
  const h = fill.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.58 ? "#111111" : "#ffffff";
}

function drawPath(ctx: CanvasRenderingContext2D, g: Geometry, W: number, H: number) {
  ctx.beginPath();
  if (g.kind === "pen") {
    g.path.forEach((p, i) => {
      const x = p.x * W;
      const y = p.y * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  } else if (g.kind === "rect") {
    ctx.rect(g.x * W, g.y * H, g.w * W, g.h * H);
  }
}

/** Top-left-ish anchor for a code label, in normalized coords. */
export function anchorOf(g: Geometry): NPoint {
  if (g.kind === "rect") return { x: g.x, y: g.y };
  if (g.kind === "pin") return { x: g.x, y: g.y };
  return g.path[0] ?? { x: 0, y: 0 };
}

export function drawShape(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  W: number,
  H: number,
  emphasized = false,
  color = MARKUP_COLOR,
) {
  const line = strokeWidth(W, H, emphasized);
  const immediateHalo = readableTextColor(color);
  const outerHalo = immediateHalo === "#ffffff" ? "#111111" : "#ffffff";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (g.kind === "pen" || g.kind === "rect") {
    if (emphasized) {
      ctx.save();
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = color;
      if (g.kind === "rect") {
        ctx.fillRect(g.x * W, g.y * H, g.w * W, g.h * H);
      }
      ctx.restore();
    }
    // A two-tone halo keeps the mark visible on both light and dark or mixed
    // imagery; the chosen mark color then sits on a maximum-contrast edge.
    for (const [strokeStyle, lineWidth] of [
      [outerHalo, line + 6],
      [immediateHalo, line + 3],
      [color, line],
    ] as const) {
      drawPath(ctx, g, W, H);
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
  } else {
    const radius = pinRadius(W, H, emphasized);
    for (const [fillStyle, extra] of [
      [outerHalo, 5],
      [immediateHalo, 2.5],
      [color, 0],
    ] as const) {
      ctx.beginPath();
      ctx.arc(g.x * W, g.y * H, radius + extra, 0, Math.PI * 2);
      ctx.fillStyle = fillStyle;
      ctx.fill();
    }
  }
}

export function drawLabel(
  ctx: CanvasRenderingContext2D,
  code: string,
  g: Geometry,
  W: number,
  H: number,
  color = MARKUP_COLOR,
) {
  if (!code) return;
  const a = anchorOf(g);
  const fontH = Math.max(11, unit(W, H) * 0.02);
  const padX = fontH * 0.35;
  ctx.font = `600 ${fontH}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "middle";
  const textW = ctx.measureText(code).width;
  const bw = textW + padX * 2;
  const bh = fontH + fontH * 0.5;
  let bx = a.x * W;
  let by = a.y * H - bh - 2;
  if (by < 0) by = a.y * H + 2;
  bx = Math.max(0, Math.min(bx, W - bw));
  ctx.fillStyle = "#111827";
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, fontH * 0.12);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = "#ffffff";
  ctx.fillText(code, bx + padX, by + bh / 2 + 0.5);
}

/** Draw a committed annotation (shape + its reference-code badge). */
export function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  W: number,
  H: number,
  emphasized = false,
) {
  for (const m of annotationMarkups(a)) {
    drawShape(ctx, m.geometry, W, H, emphasized, m.color);
    drawLabel(ctx, a.refCode, m.geometry, W, H, m.color);
  }
}
