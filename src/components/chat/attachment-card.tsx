import * as React from "react";
import type { Icon } from "@phosphor-icons/react";
import { CircleNotch } from "@phosphor-icons/react/dist/ssr";

import { parseCsvPreview } from "@/lib/csv-preview";
import { cn } from "@/lib/utils";

import { FileName } from "./file-name";

/**
 * The one card look for an attachment, shared by the pins that ride on a text
 * bubble and by standalone (no-text) file attachments, so they're consistent:
 *
 *   ┌─────────────┐
 *   │   preview   │  ← thumbnail (image/video) or a big type glyph
 *   ├─────────────┤
 *   │ ▣ filename  │  ← small type glyph + middle-truncated name (+ optional size)
 *   └─────────────┘
 */
export function AttachmentCard({
  glyph: Glyph,
  filename,
  thumbnailUrl,
  isVideo,
  textPreview,
  textPreviewFormat = "plain",
  textPreviewLoading = false,
  sizeLabel,
  tilt,
  onClick,
  className,
}: {
  glyph: Icon;
  filename: string;
  /** Presigned URL for a real image/video thumbnail; falls back to the glyph. */
  thumbnailUrl?: string | null;
  isVideo?: boolean;
  /** A head of the file's text content — shown as a document-style peek when
   *  there's no image/video thumbnail (markdown / text / code files). */
  textPreview?: string | null;
  textPreviewFormat?: "plain" | "markdown" | "csv";
  /** Keeps CSV cards at their final geometry while the content head loads. */
  textPreviewLoading?: boolean;
  sizeLabel?: string | null;
  /** Degrees of rotation (pins only). Omit for a flat standalone card. */
  tilt?: number;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
}) {
  const tilted = typeof tilt === "number";
  const activate = (event: React.MouseEvent) => {
    if (event.detail > 0 && window.getSelection()?.toString()) return;
    onClick?.(event);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.currentTarget.click();
      }}
      title={filename}
      data-selectable-text="true"
      style={tilted ? { transform: `rotate(${tilt}deg)` } : undefined}
      className={cn(
        "group pointer-events-auto flex w-36 max-w-full cursor-pointer flex-col overflow-hidden border bg-card text-left text-foreground shadow-md transition-transform hover:-translate-y-0.5 hover:shadow-lg",
        tilted && "hover:rotate-0",
        className,
      )}
    >
      {/* Preview: a real thumbnail for images/video, a content peek for text/md,
          else a big type glyph. */}
      <div className="relative flex h-24 w-full items-center justify-center overflow-hidden bg-muted text-muted-foreground">
        {thumbnailUrl ? (
          isVideo ? (
            <video src={thumbnailUrl} muted draggable={false} className="h-full w-full select-none object-cover" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URL
            <img src={thumbnailUrl} alt="" draggable={false} className="sdr-media h-full w-full select-none object-cover" />
          )
        ) : textPreviewFormat === "csv" && textPreview ? (
          <CompactCsvPreview source={textPreview} />
        ) : textPreviewFormat === "csv" && textPreviewLoading ? (
          <div
            className="absolute inset-0 grid place-items-center bg-card text-muted-foreground"
            role="status"
            aria-label="loading CSV preview"
          >
            <span className="flex flex-col items-center gap-1 text-[9px]">
              <CircleNotch className="size-4 animate-spin" />
              loading CSV…
            </span>
          </div>
        ) : textPreview ? (
          <>
            {/* tiny document-style peek of the file's text, fading out at the
                bottom so a clipped last line doesn't look broken. */}
            <pre className="absolute inset-0 overflow-hidden whitespace-pre-wrap break-words bg-card p-2 text-left font-mono text-[7px] leading-[1.45] text-foreground/80 [overflow-wrap:anywhere]">
              {textPreviewFormat === "markdown" ? markdownExcerpt(textPreview) : textPreview}
            </pre>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-b from-transparent to-card" />
          </>
        ) : (
          <Glyph className="h-9 w-9 transition-transform group-hover:scale-110" weight="thin" />
        )}
      </div>
      {/* Footer: small type-glyph + middle-truncated filename (+ optional size). */}
      <div className="flex items-center gap-1 border-t px-2 py-1.5">
        <Glyph className="h-3 w-3 shrink-0 text-muted-foreground" weight="regular" />
        <FileName name={filename} head={4} tail={8} className="text-[11px]" />
        {sizeLabel ? (
          <span className="label-mono ml-auto shrink-0 text-[9px] text-muted-foreground">
            {sizeLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function CompactCsvPreview({ source }: { source: string }) {
  const preview = parseCsvPreview(source, {
    maxRows: 3,
    maxColumns: 3,
    maxCellCharacters: 80,
  });
  if (preview.columnCount === 0) return null;
  return (
    <div className="absolute inset-0 overflow-hidden bg-card p-1 font-mono text-[6px] leading-tight">
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr className="bg-muted text-foreground">
            {preview.headers.map((header, index) => (
              <th key={index} className="truncate border px-1 py-0.5 text-left font-semibold">
                {header || `Column ${index + 1}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {preview.headers.map((_, columnIndex) => (
                <td key={columnIndex} className="truncate border px-1 py-0.5">
                  {row[columnIndex] || "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-b from-transparent to-card" />
    </div>
  );
}

function markdownExcerpt(source: string): string {
  return source
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^\s*\d+[.)]\s+/gm, "• ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(`{1,3}|\*\*|__|~~)/g, "")
    .trim();
}
