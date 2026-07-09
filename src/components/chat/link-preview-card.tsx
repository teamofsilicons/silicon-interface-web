"use client";

import * as React from "react";
import { ArrowSquareOut } from "@phosphor-icons/react/dist/ssr";

import type { LinkPreview } from "@/lib/types";

interface Props {
  preview: LinkPreview;
}

/** Only http(s) URLs are safe to linkify — `javascript:`/`data:`/`file:` etc.
 *  must never become a clickable anchor in the chat surface. Returns the URL
 *  if its scheme is allowed, else null. */
function safeHttpUrl(raw?: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** Renders Glass's OG-style link preview as a compact card. Click anywhere
 *  opens the URL in a new tab. */
export function LinkPreviewCard({ preview }: Props) {
  const safeUrl = safeHttpUrl(preview?.url);
  if (!safeUrl) return null;
  // Likewise only render an OG image if it's an http(s) (or protocol-relative
  // becomes such) resource — never a data:/javascript: src.
  const safeImage = safeHttpUrl(preview.image);
  const title = preview.title || preview.host || safeUrl;
  return (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-2 flex max-w-md items-stretch border bg-card text-foreground transition-colors hover:bg-accent"
    >
      {safeImage && (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary OG URL
        <img
          src={safeImage}
          alt=""
          className="sdr-media h-20 w-20 shrink-0 object-cover"
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 px-3 py-2">
        <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="truncate">{preview.host}</span>
          <ArrowSquareOut className="h-2.5 w-2.5 shrink-0 opacity-70" />
        </div>
        <div className="line-clamp-2 text-xs font-medium">{title}</div>
        {preview.description && (
          <div className="line-clamp-2 text-[11px] text-muted-foreground">
            {preview.description}
          </div>
        )}
      </div>
    </a>
  );
}
