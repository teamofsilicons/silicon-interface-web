"use client";

import * as React from "react";
import { PencilSimple, Trash } from "@phosphor-icons/react/dist/ssr";

import { clamp, geometryBBox } from "@/lib/annotation-coords";
import { MARKUP_COLOR, annotationMarkups, type Annotation } from "@/lib/annotation-types";
import { cn } from "@/lib/utils";

/** Shared handlers/state for the on-document comment bubbles, threaded from the
 *  studio through both stages. */
export interface CommentLayerState {
  selectedId: string | null;
  /** Chip-only mode: bubbles collapse to their ref-code chip (hover expands). */
  collapsed: boolean;
  /** Annotation whose comment is being edited — its bubble hides so it doesn't
   *  double up with the comment prompt anchored at the same markup. */
  hideId?: string | null;
  /** Dim + disable the layer while a comment prompt is open. */
  muted?: boolean;
  onSelect: (a: Annotation) => void;
  onEdit: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
}

interface Props extends CommentLayerState {
  /** Committed annotations for THIS page. */
  annotations: Annotation[];
  /** CSS-pixel size of the page box the layer covers. */
  boxW: number;
  boxH: number;
}

const BUBBLE_W = 208; // w-52
const CHIP_W = 34;
const GAP = 10;
const EDGE = 6;
const V_GAP = 6;

/** Union bbox over all of an annotation's markups, normalized. */
function annotationBBox(a: Annotation): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const m of annotationMarkups(a)) {
    const bb = geometryBBox(m.geometry);
    x0 = Math.min(x0, bb.x0);
    y0 = Math.min(y0, bb.y0);
    x1 = Math.max(x1, bb.x1);
    y1 = Math.max(y1, bb.y1);
  }
  return { x0, y0, x1, y1 };
}

/** Rough bubble height for the stacking pass — exact heights don't matter, we
 *  only need overlapping bubbles pushed apart enough to stay grabbable. */
function estimateHeight(a: Annotation, collapsed: boolean): number {
  if (collapsed) return 26;
  const lines = Math.min(3, Math.max(1, Math.ceil(a.comment.length / 32)));
  return 32 + lines * 16;
}

/**
 * The on-document comment layer: every committed annotation renders a bubble —
 * its ref-code chip (in the markup's contrast color) plus the comment text —
 * anchored next to the markup, right on top of the image / PDF page. Bubbles
 * select on click, edit on double-click (or the pencil), delete on the trash,
 * and stack downward when they'd overlap. This is the WYSIWYG counterpart of
 * the callouts burned into the attached export.
 */
export function CommentLayer({
  annotations,
  boxW,
  boxH,
  selectedId,
  collapsed,
  hideId,
  muted,
  onSelect,
  onEdit,
  onDelete,
}: Props) {
  const placed = React.useMemo(() => {
    if (boxW <= 0 || boxH <= 0) return [];
    const items = annotations
      .filter((a) => a.id !== hideId)
      .map((a) => ({ a, bb: annotationBBox(a) }))
      .sort((p, q) => p.bb.y0 - q.bb.y0 || p.bb.x0 - q.bb.x0);

    const rects: { left: number; top: number; h: number; w: number }[] = [];
    return items.map(({ a, bb }) => {
      const expanded = !collapsed || a.id === selectedId;
      const w = expanded ? BUBBLE_W : CHIP_W;
      // Prefer the right of the markup; flip left if it would overflow the page.
      let left = bb.x1 * boxW + GAP;
      if (left + w > boxW - EDGE) left = bb.x0 * boxW - GAP - w;
      left = clamp(left, EDGE, Math.max(EDGE, boxW - w - EDGE));
      const h = estimateHeight(a, !expanded);
      let top = clamp(bb.y0 * boxH, EDGE, Math.max(EDGE, boxH - h - EDGE));
      // Push below any already-placed bubble it would cover.
      for (const r of rects) {
        const overlapsX = left < r.left + r.w && left + w > r.left;
        if (overlapsX && top < r.top + r.h + V_GAP && top + h > r.top) {
          top = r.top + r.h + V_GAP;
        }
      }
      rects.push({ left, top, h, w });
      return { a, left, top, w };
    });
  }, [annotations, boxW, boxH, collapsed, hideId, selectedId]);

  if (placed.length === 0) return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        muted && "opacity-40",
      )}
      aria-label="annotation comments"
    >
      {placed.map(({ a, left, top, w }) => {
        const selected = a.id === selectedId;
        const color = a.color || annotationMarkups(a)[0]?.color || MARKUP_COLOR;
        const expanded = !collapsed || selected;
        return (
          <div
            key={a.id}
            role="button"
            tabIndex={muted ? -1 : 0}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(a);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEdit(a);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(a);
              }
            }}
            aria-label={`annotation ${a.refCode}: ${a.comment}`}
            className={cn(
              "group/bubble absolute cursor-pointer border bg-[#fffdf5] text-[#111827] shadow-sm transition-colors hover:z-[2]",
              muted ? "pointer-events-none" : "pointer-events-auto",
              selected
                ? "z-[2] border-foreground"
                : "z-[1] border-border hover:border-foreground/50",
            )}
            style={{ left, top, width: w, borderLeft: `3px solid ${color}` }}
          >
            <div className="flex items-center gap-1 px-1.5 py-1">
              <span
                className="label-mono shrink-0 bg-[#111827] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
              >
                {a.refCode}
              </span>
              <span className="min-w-0 flex-1" />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(a);
                }}
                aria-label={`edit ${a.refCode}`}
                className={cn(
                  "p-0.5 text-[#374151] transition-opacity hover:text-[#111827]",
                  selected ? "opacity-100" : "opacity-0 group-hover/bubble:opacity-100",
                )}
              >
                <PencilSimple className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(a);
                }}
                aria-label={`delete ${a.refCode}`}
                className={cn(
                  "p-0.5 text-[#374151] transition-opacity hover:text-[#7f1d1d]",
                  selected ? "opacity-100" : "opacity-0 group-hover/bubble:opacity-100",
                )}
              >
                <Trash className="h-3.5 w-3.5" />
              </button>
            </div>
            <p
              className={cn(
                "whitespace-pre-wrap break-words px-1.5 pb-1.5 text-xs leading-snug text-[#111827]",
                !selected && "line-clamp-3",
                expanded ? "block" : "hidden",
              )}
            >
              {a.comment}
            </p>
          </div>
        );
      })}
    </div>
  );
}
