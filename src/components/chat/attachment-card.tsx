import * as React from "react";
import type { Icon } from "@phosphor-icons/react";

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
  sizeLabel?: string | null;
  /** Degrees of rotation (pins only). Omit for a flat standalone card. */
  tilt?: number;
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
}) {
  const tilted = typeof tilt === "number";
  return (
    <button
      type="button"
      onClick={onClick}
      title={filename}
      style={tilted ? { transform: `rotate(${tilt}deg)` } : undefined}
      className={cn(
        "group pointer-events-auto flex w-36 max-w-full flex-col overflow-hidden border bg-card text-left text-foreground shadow-md transition-transform hover:-translate-y-0.5 hover:shadow-lg",
        tilted && "hover:rotate-0",
        className,
      )}
    >
      {/* Preview: a real thumbnail for images/video, else a big type glyph. */}
      <div className="flex h-24 w-full items-center justify-center overflow-hidden bg-muted text-muted-foreground">
        {thumbnailUrl ? (
          isVideo ? (
            <video src={thumbnailUrl} muted className="h-full w-full object-cover" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URL
            <img src={thumbnailUrl} alt="" className="h-full w-full object-cover" />
          )
        ) : (
          <Glyph className="h-9 w-9 transition-transform group-hover:scale-110" weight="thin" />
        )}
      </div>
      {/* Footer: small type-glyph + middle-truncated filename (+ optional size). */}
      <div className="flex items-center gap-1 border-t px-2 py-1.5">
        <Glyph className="h-3 w-3 shrink-0 text-muted-foreground" weight="regular" />
        <FileName name={filename} tailChars={8} className="text-[11px]" />
        {sizeLabel ? (
          <span className="label-mono ml-auto shrink-0 text-[9px] text-muted-foreground">
            {sizeLabel}
          </span>
        ) : null}
      </div>
    </button>
  );
}
