"use client";

import * as React from "react";
import { CircleNotch, PencilSimple, Trash } from "@phosphor-icons/react/dist/ssr";

import { annotationMarkups, type Annotation } from "@/lib/annotation-types";
import { cn } from "@/lib/utils";

interface Props {
  annotations: Annotation[];
  isPdf: boolean;
  selectedId: string | null;
  onSelect: (a: Annotation) => void;
  onEdit: (a: Annotation) => void;
  onDelete: (a: Annotation) => void;
}

/**
 * The running list of committed annotations. Each row shows its reference code,
 * comment, and (for PDFs) page. Clicking a row highlights its markup on the
 * stage (jumping to that page if needed — handled upstream); the row also
 * exposes edit-comment and delete.
 */
export function AnnotationsPanel({ annotations, isPdf, selectedId, onSelect, onEdit, onDelete }: Props) {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l bg-background" aria-label="annotations list">
      <div className="shrink-0 border-b px-3 py-2">
        <span className="label-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          annotations · {annotations.length}
        </span>
      </div>
      {annotations.length === 0 ? (
        <p className="p-4 text-xs text-muted-foreground">
          draw on the document, then add a comment. each one lands here with a
          reference code.
        </p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto">
          {annotations.map((a) => (
            <li
              key={a.id}
              tabIndex={0}
              className={cn(
                "group cursor-pointer border-b px-3 py-2 transition-colors focus-visible:bg-muted",
                a.id === selectedId ? "bg-muted" : "hover:bg-muted/50",
              )}
              onClick={() => onSelect(a)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(a);
                }
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="label-mono shrink-0 bg-foreground px-1.5 py-0.5 text-[11px] font-semibold text-background">
                    {a.refCode}
                  </span>
                  {a.refStatus === "pending" && (
                    <CircleNotch
                      className="h-3 w-3 shrink-0 animate-spin text-muted-foreground"
                      aria-label="naming annotation"
                    />
                  )}
                  {isPdf && (
                    <span className="label-mono shrink-0 text-[10px] text-muted-foreground">
                      p{a.page + 1}
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(a);
                    }}
                    aria-label={`edit ${a.refCode}`}
                    className="p-1 text-muted-foreground hover:text-foreground"
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
                    className="p-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">
                {a.comment}
              </p>
              {annotationMarkups(a).length > 1 && (
                <p className="label-mono mt-1 text-[10px] text-muted-foreground">
                  {annotationMarkups(a).length} marks
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
