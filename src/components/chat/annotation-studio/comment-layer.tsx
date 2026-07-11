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
  /** Comment cards become drag handles for the complete annotation in move mode. */
  moveEnabled: boolean;
  /** Annotation whose comment is being edited — its bubble hides so it doesn't
   *  double up with the comment prompt anchored at the same markup. */
  hideId?: string | null;
  /** Dim + disable the layer while a comment prompt is open. */
  muted?: boolean;
  onSelect: (a: Annotation) => void;
  onEdit: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
  onMove: (id: string, dx: number, dy: number) => void;
}

interface Props extends CommentLayerState {
  /** Committed annotations for THIS page. */
  annotations: Annotation[];
  /** CSS-pixel size of the page box the layer covers. */
  boxW: number;
  boxH: number;
}

const BUBBLE_W = 208; // w-52
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
function estimateHeight(a: Annotation): number {
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
  moveEnabled,
  hideId,
  muted,
  onSelect,
  onEdit,
  onDelete,
  onMove,
}: Props) {
  const dragRef = React.useRef<{
    id: string;
    pointerId: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const ignoreClickRef = React.useRef<string | null>(null);
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const placed = React.useMemo(() => {
    if (boxW <= 0 || boxH <= 0) return [];
    const items = annotations
      .filter((a) => a.id !== hideId)
      .map((a) => ({ a, bb: annotationBBox(a) }))
      .sort((p, q) => p.bb.y0 - q.bb.y0 || p.bb.x0 - q.bb.x0);

    const rects: { left: number; top: number; h: number; w: number }[] = [];
    return items.map(({ a, bb }) => {
      const w = BUBBLE_W;
      // Prefer the right of the markup; flip left if it would overflow the page.
      let left = bb.x1 * boxW + GAP;
      if (left + w > boxW - EDGE) left = bb.x0 * boxW - GAP - w;
      left = clamp(left, EDGE, Math.max(EDGE, boxW - w - EDGE));
      const h = estimateHeight(a);
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
  }, [annotations, boxW, boxH, hideId]);

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
        const color = annotationMarkups(a)[0]?.color || MARKUP_COLOR;
        const dragging = draggingId === a.id;
        return (
          <div
            key={a.id}
            role="button"
            tabIndex={muted ? -1 : 0}
            onClick={(e) => {
              e.stopPropagation();
              if (ignoreClickRef.current === a.id) {
                ignoreClickRef.current = null;
                return;
              }
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
            onPointerDown={(e) => {
              if (!moveEnabled || muted || (e.target as HTMLElement).closest("button")) return;
              e.preventDefault();
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              dragRef.current = {
                id: a.id,
                pointerId: e.pointerId,
                x: e.clientX,
                y: e.clientY,
                moved: false,
              };
              setDraggingId(a.id);
              onSelect(a);
            }}
            onPointerMove={(e) => {
              const drag = dragRef.current;
              if (!drag || drag.id !== a.id || drag.pointerId !== e.pointerId) return;
              const dxPx = e.clientX - drag.x;
              const dyPx = e.clientY - drag.y;
              if (Math.abs(dxPx) + Math.abs(dyPx) >= 2) drag.moved = true;
              if (dxPx || dyPx) onMove(a.id, dxPx / boxW, dyPx / boxH);
              drag.x = e.clientX;
              drag.y = e.clientY;
            }}
            onPointerUp={(e) => {
              const drag = dragRef.current;
              if (!drag || drag.id !== a.id || drag.pointerId !== e.pointerId) return;
              if (drag.moved) ignoreClickRef.current = a.id;
              dragRef.current = null;
              setDraggingId(null);
            }}
            onPointerCancel={() => {
              dragRef.current = null;
              setDraggingId(null);
            }}
            aria-label={`annotation ${a.refCode}: ${a.comment}`}
            className={cn(
              "group/bubble absolute border bg-background text-foreground shadow-sm transition-colors hover:z-[2]",
              muted ? "pointer-events-none" : "pointer-events-auto",
              moveEnabled && (dragging ? "cursor-grabbing" : "cursor-grab"),
              !moveEnabled && "cursor-pointer",
              selected
                ? "z-[2] border-foreground"
                : "z-[1] border-border hover:border-foreground/50",
            )}
            style={{ left, top, width: w, borderLeft: `3px solid ${color}` }}
          >
            <div className="flex items-center gap-1 px-1.5 py-1">
              <span
                className="label-mono shrink-0 border border-foreground bg-background px-1.5 py-0.5 text-[10px] font-semibold leading-none text-foreground"
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
                  "p-0.5 text-foreground transition-opacity hover:bg-muted",
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
                  "p-0.5 text-foreground transition-opacity hover:text-destructive",
                  selected ? "opacity-100" : "opacity-0 group-hover/bubble:opacity-100",
                )}
              >
                <Trash className="h-3.5 w-3.5" />
              </button>
            </div>
            <p
              className={cn(
                "whitespace-pre-wrap break-words px-1.5 pb-1.5 text-xs leading-snug text-foreground",
                !selected && "line-clamp-3",
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
