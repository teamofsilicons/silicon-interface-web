import type { Geometry, NPoint } from "./annotation-types";

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalized bounding box of a markup geometry ([0,1] on both axes). */
export function geometryBBox(g: Geometry): { x0: number; y0: number; x1: number; y1: number } {
  if (g.kind === "rect") return { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h };
  if (g.kind === "pin") return { x0: g.x, y0: g.y, x1: g.x, y1: g.y };
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const p of g.path) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return g.path.length ? { x0, y0, x1, y1 } : { x0: 0, y0: 0, x1: 0, y1: 0 };
}

/**
 * Map a pointer's viewport coords to normalized [0,1] coords within `box`
 * (the page box's `getBoundingClientRect()`). Dividing by the live box size is
 * what makes stored geometry independent of the studio's on-screen size.
 */
export function toNormalized(clientX: number, clientY: number, box: DOMRect): NPoint {
  return {
    x: clamp01((clientX - box.left) / Math.max(1, box.width)),
    y: clamp01((clientY - box.top) / Math.max(1, box.height)),
  };
}

/** Contain-fit `(srcW,srcH)` inside `(maxW,maxH)`, preserving aspect ratio. */
export function fitContain(
  maxW: number,
  maxH: number,
  srcW: number,
  srcH: number,
): { w: number; h: number } {
  if (srcW <= 0 || srcH <= 0 || maxW <= 0 || maxH <= 0) return { w: 0, h: 0 };
  const scale = Math.min(maxW / srcW, maxH / srcH);
  return { w: Math.round(srcW * scale), h: Math.round(srcH * scale) };
}
