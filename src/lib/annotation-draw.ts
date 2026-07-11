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
  const base = Math.max(4, unit(W, H) * 0.008);
  return emphasized ? base * 1.25 : base;
}
function pinRadius(W: number, H: number, emphasized: boolean): number {
  const r = Math.max(6, unit(W, H) * 0.013);
  return emphasized ? r * 1.25 : r;
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
  const ink = "#1a1a1a";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (g.kind === "pen") {
    drawPath(ctx, g, W, H);
    ctx.strokeStyle = ink;
    ctx.lineWidth = line + 2;
    ctx.stroke();
    drawPath(ctx, g, W, H);
    ctx.globalAlpha = emphasized ? 1 : 0.88;
    ctx.strokeStyle = color;
    ctx.lineWidth = line;
    ctx.stroke();
    ctx.globalAlpha = 1;
  } else if (g.kind === "rect") {
    ctx.save();
    ctx.globalAlpha = emphasized ? 0.34 : 0.22;
    ctx.fillStyle = color;
    ctx.fillRect(g.x * W, g.y * H, g.w * W, g.h * H);
    ctx.restore();
    drawPath(ctx, g, W, H);
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(2, line * 0.45);
    ctx.stroke();
  } else {
    const radius = pinRadius(W, H, emphasized);
    ctx.beginPath();
    ctx.arc(g.x * W, g.y * H, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(2, radius * 0.18);
    ctx.stroke();
  }
}

export function drawLabel(
  ctx: CanvasRenderingContext2D,
  code: string,
  g: Geometry,
  W: number,
  H: number,
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
  ctx.fillStyle = "#ede8e0";
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = Math.max(1, fontH * 0.08);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = "#1a1a1a";
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
    drawLabel(ctx, a.refCode, m.geometry, W, H);
  }
}
