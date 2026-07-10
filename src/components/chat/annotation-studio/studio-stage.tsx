"use client";

import * as React from "react";

import { clamp, fitContain, geometryBBox } from "@/lib/annotation-coords";
import type { Annotation, Geometry, MarkupDraft, ToolKind } from "@/lib/annotation-types";
import { cn } from "@/lib/utils";

import { CommentLayer, type CommentLayerState } from "./comment-layer";
import { COMMENT_PROMPT_WIDTH, CommentPrompt } from "./comment-prompt";
import { OverlayCanvas } from "./overlay-canvas";

/** Props for the contextual comment popover, anchored to a markup's geometry. */
export interface CommentState {
  promptKey: string;
  initial: string;
  title: string;
  anchor: Geometry;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
  onAddMarkup?: (commentDraft: string) => void;
  markupCount?: number;
}

interface Props {
  /** Image URL, or the rendered PDF page's data URL. */
  displayUrl: string;
  alt: string;
  /** Intrinsic page size (natural image px, or PDF page points) for aspect. */
  pageW: number;
  pageH: number;
  /** Committed annotations for the CURRENT page. */
  annotations: Annotation[];
  tool: ToolKind;
  onCommit: (g: Geometry) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onSelect: (annotation: Annotation) => void;
  /** Dim the render layer while a PDF page re-renders. */
  dimmed?: boolean;
  /** A finished-but-uncommitted markup, drawn emphasized while commenting. */
  pending?: MarkupDraft | MarkupDraft[] | null;
  /** Id of an annotation to draw emphasized (selected in the list). */
  highlightId?: string | null;
  /** Ignore pointer input (e.g. while the comment prompt is open). */
  locked?: boolean;
  /** When set, render the comment popover anchored next to `anchor`. */
  comment?: CommentState | null;
  /** On-document comment bubbles (chip + comment text over the page). */
  commentLayer?: CommentLayerState | null;
  zoom?: number;
}

const POP_W = COMMENT_PROMPT_WIDTH;
const POP_H = 168; // estimate for clamping; card is compact
const GAP = 12;
const EDGE = 8;

/**
 * Composes the render layer (image / PDF page) with the transparent drawing
 * overlay, and positions the comment popover as a contextual card next to the
 * markup being commented.
 *
 * The page box is sized in JS to a contain-fit of the page aspect inside the
 * available area (no letterboxing), so the overlay is pixel-aligned with the
 * page and normalized coords map exactly. The page box is centered, so a
 * markup's container-space position is `((container−box)/2) + normalized·box` —
 * that's how the popover finds the markup.
 */
export function StudioStage({
  displayUrl,
  alt,
  pageW,
  pageH,
  annotations,
  tool,
  onCommit,
  onMove,
  onSelect,
  dimmed,
  pending,
  highlightId,
  locked,
  comment,
  commentLayer,
  zoom = 1,
}: Props) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = React.useState({ w: 0, h: 0 });

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setContainer({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const box = React.useMemo(() => {
    const fit = fitContain(container.w, container.h, pageW, pageH);
    return { w: Math.round(fit.w * zoom), h: Math.round(fit.h * zoom) };
  }, [container.w, container.h, pageW, pageH, zoom]);
  const contentW = Math.max(container.w, box.w);
  const contentH = Math.max(container.h, box.h);
  const boxLeft = (contentW - box.w) / 2;
  const boxTop = (contentH - box.h) / 2;

  // Position the comment popover next to its anchor markup, in container coords.
  const popPos = React.useMemo(() => {
    if (!comment || box.w <= 0) return null;
    const bb = geometryBBox(comment.anchor);
    const mx0 = boxLeft + bb.x0 * box.w;
    const mx1 = boxLeft + bb.x1 * box.w;
    const my0 = boxTop + bb.y0 * box.h;
    // Prefer the right of the markup; flip to the left if it would overflow.
    let left = mx1 + GAP;
    if (left + POP_W > contentW - EDGE) left = mx0 - GAP - POP_W;
    left = clamp(left, EDGE, Math.max(EDGE, contentW - POP_W - EDGE));
    const top = clamp(my0, EDGE, Math.max(EDGE, contentH - POP_H - EDGE));
    return { left, top };
  }, [comment, box.w, box.h, boxLeft, boxTop, contentW, contentH]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-auto">
      {box.w > 0 && box.h > 0 && (
        <div
          className="relative"
          style={{ width: contentW, height: contentH }}
        >
          <div className="absolute shadow-sm" style={{ left: boxLeft, top: boxTop, width: box.w, height: box.h }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- rendered/presigned URL */}
            <img
              src={displayUrl}
              alt={alt}
              draggable={false}
              className={cn("absolute inset-0 h-full w-full select-none", dimmed && "opacity-60")}
            />
            <OverlayCanvas
              width={box.w}
              height={box.h}
              annotations={annotations}
              tool={tool}
              onCommit={onCommit}
              onMove={onMove}
              onSelect={onSelect}
              pending={pending}
              highlightId={highlightId}
              locked={locked}
            />
            {commentLayer && (
              <CommentLayer
                annotations={annotations}
                boxW={box.w}
                boxH={box.h}
                {...commentLayer}
              />
            )}
          </div>

          {comment && popPos && (
            <div className="absolute z-10" style={{ left: popPos.left, top: popPos.top }}>
              <CommentPrompt
                key={comment.promptKey}
                initial={comment.initial}
                title={comment.title}
                onSubmit={comment.onSubmit}
                onCancel={comment.onCancel}
                onAddMarkup={comment.onAddMarkup}
                markupCount={comment.markupCount}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
