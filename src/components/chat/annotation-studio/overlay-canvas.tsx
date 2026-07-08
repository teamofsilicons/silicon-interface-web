"use client";

import * as React from "react";

import { toNormalized } from "@/lib/annotation-coords";
import { drawLabel, drawShape } from "@/lib/annotation-draw";
import {
  annotationMarkups,
  type Annotation,
  type Geometry,
  MARKUP_COLOR,
  type MarkupDraft,
  type NPoint,
  type ToolKind,
} from "@/lib/annotation-types";

interface Props {
  /** CSS-pixel size of the page box (the overlay covers it exactly). */
  width: number;
  height: number;
  /** Committed annotations for the CURRENT page. */
  annotations: Annotation[];
  tool: ToolKind;
  /** Called with a finished markup's normalized geometry (awaits a comment). */
  onCommit: (g: Geometry) => void;
  /** A finished-but-uncommitted markup, drawn emphasized while its comment is
   *  being entered. */
  pending?: MarkupDraft | MarkupDraft[] | null;
  /** Id of an annotation to draw emphasized (selected in the list). */
  highlightId?: string | null;
  /** When true, ignore pointer input (e.g. while the comment prompt is open). */
  locked?: boolean;
}

function readDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  return Math.min(3, Math.max(1, window.devicePixelRatio || 1));
}

/**
 * Transparent drawing surface stacked over the render layer. Captures pointer
 * gestures per the active tool, keeps the in-progress stroke in local `draft`
 * state, and hands a finished markup's normalized geometry to `onCommit` (which
 * gates it behind a required comment). Redraws (committed markups + their code
 * labels + the live draft + the pending markup) happen in an effect that only
 * touches the canvas — never React state — so it stays lint-clean.
 */
export function OverlayCanvas({
  width,
  height,
  annotations,
  tool,
  onCommit,
  pending,
  highlightId,
  locked,
}: Props) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [draft, setDraft] = React.useState<Geometry | null>(null);
  const drawingRef = React.useRef(false);
  const startRef = React.useRef<NPoint | null>(null);
  const [dpr, setDpr] = React.useState(readDevicePixelRatio);

  React.useEffect(() => {
    const update = () => setDpr(readDevicePixelRatio());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    for (const a of annotations) {
      for (const m of annotationMarkups(a)) {
        drawShape(ctx, m.geometry, width, height, a.id === highlightId, m.color);
        drawLabel(ctx, a.refCode, m.geometry, width, height, m.color);
      }
    }
    const pendingMarks = Array.isArray(pending) ? pending : pending ? [pending] : [];
    for (const m of pendingMarks) drawShape(ctx, m.geometry, width, height, true, m.color);
    if (draft) drawShape(ctx, draft, width, height, false, MARKUP_COLOR);
  }, [annotations, draft, pending, highlightId, width, height, dpr]);

  const boxRect = () => canvasRef.current!.getBoundingClientRect();

  const onPointerDown = (e: React.PointerEvent) => {
    if (locked) return;
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    const p = toNormalized(e.clientX, e.clientY, boxRect());
    if (tool === "pin") {
      onCommit({ kind: "pin", x: p.x, y: p.y });
      return;
    }
    drawingRef.current = true;
    startRef.current = p;
    setDraft(tool === "pen" ? { kind: "pen", path: [p] } : { kind: "rect", x: p.x, y: p.y, w: 0, h: 0 });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    const p = toNormalized(e.clientX, e.clientY, boxRect());
    if (tool === "pen") {
      setDraft((d) => (d && d.kind === "pen" ? { kind: "pen", path: [...d.path, p] } : d));
    } else if (tool === "rect") {
      const s = startRef.current!;
      setDraft({
        kind: "rect",
        x: Math.min(s.x, p.x),
        y: Math.min(s.y, p.y),
        w: Math.abs(p.x - s.x),
        h: Math.abs(p.y - s.y),
      });
    }
  };

  const finish = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const d = draft;
    setDraft(null);
    startRef.current = null;
    if (!d) return;
    // Drop degenerate marks: a rect with no drag, or a pen tap with one point.
    if (d.kind === "rect" && (d.w < 0.004 || d.h < 0.004)) return;
    if (d.kind === "pen" && d.path.length < 2) return;
    onCommit(d);
  };

  return (
    <canvas
      ref={canvasRef}
      width={Math.round(width * dpr)}
      height={Math.round(height * dpr)}
      style={{
        width,
        height,
        touchAction: "none",
        cursor: locked ? "default" : "crosshair",
        pointerEvents: locked ? "none" : "auto",
      }}
      aria-disabled={locked || undefined}
      aria-label={`annotation drawing surface, ${tool} tool selected`}
      className="absolute inset-0"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
    />
  );
}
