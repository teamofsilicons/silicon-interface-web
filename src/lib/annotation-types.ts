/**
 * Shared types for the annotation studio.
 *
 * All geometry is stored in NORMALIZED page coordinates — x/y in [0,1] relative
 * to the page box — so a markup is resolution- and zoom-independent: it lands in
 * the same spot whether the studio is small, fullscreen, or re-rendered at high
 * resolution for the flattened export (Milestone 5).
 */

export type ToolKind = "move" | "pen" | "rect" | "pin";

/** A normalized point — x/y in [0,1] relative to the page box. */
export interface NPoint {
  x: number;
  y: number;
}

export type Geometry =
  | { kind: "pen"; path: NPoint[] }
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "pin"; x: number; y: number };

export interface MarkupDraft {
  geometry: Geometry;
  color: string;
}

/**
 * One annotation. Milestone 1 only fills `id`, `page`, and `geometry` as the
 * user draws; the required comment and the positional `refCode` (`a…z`, then
 * `a1…z1`, etc.) are attached when
 * the comment gate commits it in Milestone 2.
 */
export interface Annotation {
  /** Stable local id (crypto.randomUUID) — the React key and highlight handle. */
  id: string;
  /** 0-based page index; always 0 for images. */
  page: number;
  geometry: Geometry;
  /** Experimental grouped markups for one comment. Present when an annotation
   *  contains multiple drawn regions; `geometry`/`color` stay as the first mark
   *  for backwards compatibility with older drafts/export paths. */
  markups?: MarkupDraft[];
  /** Markup/badge color chosen for contrast against the marked region. Older
   *  autosaved annotations may omit it and fall back to MARKUP_COLOR. */
  color?: string;
  /** Positional label, e.g. "a" or "b1". Empty until committed. */
  refCode: string;
  /** Required comment. Empty until committed (M2). */
  comment: string;
}

/** Markup color, shared by the live overlay and the flatten export so the
 *  attached image matches exactly what was drawn on screen. (Stroke/pin/label
 *  sizes are computed proportionally in `annotation-draw.ts`.) */
export const MARKUP_COLOR = "#e5484d"; // vivid red — reads on light documents

/** New stable id for an annotation. */
export function newAnnotationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function annotationMarkups(a: Annotation): MarkupDraft[] {
  if (Array.isArray(a.markups) && a.markups.length > 0) return a.markups;
  return [{ geometry: a.geometry, color: a.color || MARKUP_COLOR }];
}
