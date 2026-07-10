"use client";

import * as React from "react";
import {
  ArrowUUpLeft,
  ArrowsOutCardinal,
  ChatCircleText,
  CircleNotch,
  MapPin,
  Minus,
  PaperPlaneTilt,
  PencilSimple,
  Plus,
  Rectangle,
} from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import type { ToolKind } from "@/lib/annotation-types";
import { cn } from "@/lib/utils";

interface Props {
  tool: ToolKind;
  onToolChange: (t: ToolKind) => void;
  onUndo: () => void;
  canUndo: boolean;
  isPdf: boolean;
  pageCount: number;
  renderedPageCount?: number;
  zoom: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  /** Chip-only mode for the on-document comment bubbles. */
  commentsCollapsed: boolean;
  onToggleComments: () => void;
  onAttach: () => void;
  canAttach: boolean;
  attaching: boolean;
}

const TOOLS: {
  kind: ToolKind;
  label: string;
  shortcut: string;
  Icon: React.ComponentType<{ className?: string }>;
}[] = [
  { kind: "move", label: "move", shortcut: "M", Icon: ArrowsOutCardinal },
  { kind: "pen", label: "draw", shortcut: "D", Icon: PencilSimple },
  { kind: "rect", label: "box", shortcut: "R", Icon: Rectangle },
  { kind: "pin", label: "pin", shortcut: "P", Icon: MapPin },
];

/** The studio's control bar: markup tools + undo on the left, PDF page
 *  navigation on the right. */
export function StudioToolbar({
  tool,
  onToolChange,
  onUndo,
  canUndo,
  isPdf,
  pageCount,
  renderedPageCount = pageCount,
  zoom,
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  commentsCollapsed,
  onToggleComments,
  onAttach,
  canAttach,
  attaching,
}: Props) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 overflow-x-auto border-b bg-background px-3 py-2">
      <div className="flex shrink-0 items-center gap-1.5">
        {TOOLS.map(({ kind, label, shortcut, Icon }) => {
          const active = tool === kind;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onToolChange(kind)}
              aria-pressed={active}
              aria-label={`${label} tool`}
              aria-keyshortcuts={shortcut}
              title={`${label} (${shortcut})`}
              className={cn(
                "flex items-center gap-1.5 border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-foreground hover:bg-muted",
              )}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          );
        })}
        <div className="mx-1 h-5 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="undo last markup"
          aria-keyshortcuts="Control+Z Meta+Z"
          title="undo last markup"
        >
          <ArrowUUpLeft className="h-4 w-4" /> undo
        </Button>
        <div className="mx-1 h-5 w-px bg-border" />
        <div className="flex items-center gap-1" aria-label="zoom controls">
          <Button
            size="icon"
            variant="ghost"
            onClick={onZoomOut}
            disabled={!canZoomOut}
            aria-label="zoom out"
            aria-keyshortcuts="-"
            title="zoom out"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <button
            type="button"
            onClick={onZoomReset}
            aria-label="reset zoom"
            aria-keyshortcuts="0"
            title="reset zoom"
            className="label-mono h-8 min-w-12 border border-transparent px-1 text-center text-[11px] text-foreground transition-colors hover:border-border"
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button
            size="icon"
            variant="ghost"
            onClick={onZoomIn}
            disabled={!canZoomIn}
            aria-label="zoom in"
            aria-keyshortcuts="+"
            title="zoom in"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="mx-1 h-5 w-px bg-border" />
        <button
          type="button"
          onClick={onToggleComments}
          aria-pressed={!commentsCollapsed}
          aria-label={commentsCollapsed ? "show full comments on document" : "collapse comments to chips"}
          aria-keyshortcuts="C"
          title={`${commentsCollapsed ? "show" : "collapse"} comments (C)`}
          className={cn(
            "flex items-center gap-1.5 border px-2.5 py-1 text-xs transition-colors",
            !commentsCollapsed
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-card text-foreground hover:bg-muted",
          )}
        >
          <ChatCircleText className="h-4 w-4" /> comments
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-4">
        {isPdf && (
          <span className="label-mono text-xs text-foreground">
            {renderedPageCount < pageCount
              ? `${renderedPageCount}/${pageCount} pages`
              : `${pageCount} page${pageCount === 1 ? "" : "s"}`}{" "}
            · scroll
          </span>
        )}
        <Button
          size="sm"
          onClick={onAttach}
          disabled={!canAttach || attaching}
          aria-label="attach annotations to chat"
        >
          {attaching ? (
            <CircleNotch className="h-4 w-4 animate-spin" />
          ) : (
            <PaperPlaneTilt className="h-4 w-4" />
          )}
          {attaching ? "attaching…" : "attach to chat"}
        </Button>
      </div>
    </div>
  );
}
