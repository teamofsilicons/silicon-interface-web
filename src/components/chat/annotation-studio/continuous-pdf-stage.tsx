"use client";

import * as React from "react";
import { CircleNotch } from "@phosphor-icons/react/dist/ssr";

import { clamp, geometryBBox } from "@/lib/annotation-coords";
import type { Annotation, Geometry, MarkupDraft, ToolKind } from "@/lib/annotation-types";
import { cn } from "@/lib/utils";

import { CommentLayer, type CommentLayerState } from "./comment-layer";
import { COMMENT_PROMPT_WIDTH, CommentPrompt } from "./comment-prompt";
import type { CommentState } from "./studio-stage";
import { OverlayCanvas } from "./overlay-canvas";

export interface PdfPageRender {
  page: number; // 0-based
  dataUrl: string;
  pageWidth: number;
  pageHeight: number;
}

interface Props {
  pages: PdfPageRender[];
  pageCount: number;
  label: string;
  annotations: Annotation[];
  tool: ToolKind;
  onCommit: (page: number, g: Geometry, imageSrc: string) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onSelect: (annotation: Annotation) => void;
  pending?: { page: number; markups: MarkupDraft[] } | null;
  highlightId?: string | null;
  locked?: boolean;
  comment?: (CommentState & { page: number }) | null;
  /** On-document comment bubbles (chip + comment text over each page). */
  commentLayer?: CommentLayerState | null;
  scrollToPage?: number | null;
  zoom?: number;
}

const POP_W = COMMENT_PROMPT_WIDTH;
const POP_H = 168;
const GAP = 12;
const EDGE = 8;

/**
 * Continuous PDF reading surface: every rendered page is stacked vertically and
 * owns its own overlay canvas. Stored geometry is still page-normalized, but
 * the user can now read/mark the document by scrolling instead of swapping one
 * page at a time.
 */
export function ContinuousPdfStage({
  pages,
  pageCount,
  label,
  annotations,
  tool,
  onCommit,
  onMove,
  onSelect,
  pending,
  highlightId,
  locked,
  comment,
  commentLayer,
  scrollToPage,
  zoom = 1,
}: Props) {
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const pageRefs = React.useRef(new Map<number, HTMLDivElement>());
  const [containerW, setContainerW] = React.useState(0);

  React.useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setContainerW(r.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  React.useEffect(() => {
    if (scrollToPage == null) return;
    pageRefs.current.get(scrollToPage)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [scrollToPage]);

  const pagesByIndex = React.useMemo(() => {
    const m = new Map<number, PdfPageRender>();
    for (const p of pages) m.set(p.page, p);
    return m;
  }, [pages]);

  const basePageW = Math.max(320, Math.min(880, containerW - 48));
  const pageW = Math.max(160, Math.round(basePageW * zoom));
  const contentW = Math.max(containerW, pageW + 32);
  const allPageIndexes = React.useMemo(
    () => Array.from({ length: pageCount }, (_, i) => i),
    [pageCount],
  );

  return (
    <div ref={scrollerRef} className="h-full w-full overflow-auto bg-card">
      <div
        className="mx-auto flex min-w-full flex-col items-center gap-5 px-4 py-5"
        style={{ width: contentW }}
      >
        {allPageIndexes.map((page0) => {
          const page = pagesByIndex.get(page0);
          const pageAnnotations = annotations.filter((a) => a.page === page0);
          const pagePending = pending?.page === page0 ? pending.markups : [];
          const pageComment = comment?.page === page0 ? comment : null;
          return (
            <PdfPage
              key={page0}
              ref={(el) => {
                if (el) pageRefs.current.set(page0, el);
                else pageRefs.current.delete(page0);
              }}
              page={page}
              pageIndex={page0}
              label={label}
              width={pageW}
              annotations={pageAnnotations}
              tool={tool}
              onCommit={page ? (g) => onCommit(page0, g, page.dataUrl) : () => undefined}
              onMove={onMove}
              onSelect={onSelect}
              pending={pagePending}
              highlightId={highlightId}
              locked={locked || !page}
              comment={pageComment}
              commentLayer={commentLayer}
            />
          );
        })}
      </div>
    </div>
  );
}

interface PdfPageProps {
  page?: PdfPageRender;
  pageIndex: number;
  label: string;
  width: number;
  annotations: Annotation[];
  tool: ToolKind;
  onCommit: (g: Geometry) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onSelect: (annotation: Annotation) => void;
  pending?: MarkupDraft[];
  highlightId?: string | null;
  locked?: boolean;
  comment?: CommentState | null;
  commentLayer?: CommentLayerState | null;
}

const PdfPage = React.forwardRef<HTMLDivElement, PdfPageProps>(function PdfPage(
  {
    page,
    pageIndex,
    label,
    width,
    annotations,
    tool,
    onCommit,
    onMove,
    onSelect,
    pending,
    highlightId,
    locked,
    comment,
    commentLayer,
  },
  ref,
) {
  const pageW = page?.pageWidth ?? 612;
  const pageH = page?.pageHeight ?? 792;
  const boxW = Math.max(1, Math.round(width));
  const boxH = Math.max(1, Math.round((boxW * pageH) / Math.max(1, pageW)));

  const popPos = React.useMemo(() => {
    if (!comment) return null;
    const bb = geometryBBox(comment.anchor);
    const mx0 = bb.x0 * boxW;
    const mx1 = bb.x1 * boxW;
    const my0 = bb.y0 * boxH;
    let left = mx1 + GAP;
    if (left + POP_W > boxW - EDGE) left = mx0 - GAP - POP_W;
    left = clamp(left, EDGE, Math.max(EDGE, boxW - POP_W - EDGE));
    const top = clamp(my0, EDGE, Math.max(EDGE, boxH - POP_H - EDGE));
    return { left, top };
  }, [comment, boxW, boxH]);

  return (
    <section ref={ref} className="w-full" aria-label={`page ${pageIndex + 1}`}>
      <div className="mb-1 flex items-center justify-between" style={{ width: boxW }}>
        <span className="label-mono text-[10px] uppercase text-foreground">
          page {pageIndex + 1}
        </span>
      </div>
      <div
        className={cn("relative bg-background shadow-sm ring-1 ring-border", !page && "animate-pulse")}
        style={{ width: boxW, height: boxH }}
      >
        {page ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- pdf.js render data URL */}
            <img
              src={page.dataUrl}
              alt={`${label} - page ${pageIndex + 1}`}
              draggable={false}
              className="absolute inset-0 h-full w-full select-none"
            />
            <OverlayCanvas
              width={boxW}
              height={boxH}
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
                boxW={boxW}
                boxH={boxH}
                {...commentLayer}
              />
            )}
          </>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-foreground" role="status">
            <CircleNotch className="mr-2 h-4 w-4 animate-spin" /> rendering page {pageIndex + 1}
          </div>
        )}

        {comment && popPos && (
          <div className="absolute z-10" style={{ left: popPos.left, top: popPos.top }}>
            <CommentPrompt
              key={comment.promptKey}
              initial={comment.initial}
              title={comment.title}
              onSubmit={comment.onSubmit}
              onCancel={comment.onCancel}
            />
          </div>
        )}
      </div>
    </section>
  );
});
