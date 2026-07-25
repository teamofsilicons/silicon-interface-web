"use client";

import * as React from "react";

import { MediaAttachment } from "@/components/chat/media-attachment";
import { MarkdownView } from "@/components/chat/markdown-view";
import { RemoteBrowserCard } from "@/components/chat/remote-browser-card";
import type { WorkContentBlock } from "@/lib/work-update-types";
import { cn } from "@/lib/utils";

export interface WorkContentBlocksProps {
  blocks?: WorkContentBlock[];
  roomId?: string;
  eventId?: string;
  /** Avoids rendering a text block that exactly repeats the card body. */
  excludeText?: string;
  className?: string;
}

/** Renders ordered update content with the same media/browser primitives as chat. */
export function WorkContentBlocks({
  blocks,
  roomId,
  eventId,
  excludeText,
  className,
}: WorkContentBlocksProps) {
  const visible = blocks?.filter(
    (block) => !(block.type === "text" && excludeText && block.body.trim() === excludeText.trim()),
  );
  if (!visible?.length) return null;

  return (
    <div className={cn("grid min-w-0 gap-3", className)}>
      {visible.map((block, index) => {
        const key = `${block.type}:${index}`;
        if (block.type === "text") {
          return block.format === "markdown" ? (
            <MarkdownView key={key} source={block.body} compact />
          ) : (
            <p key={key} className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
              {block.body}
            </p>
          );
        }
        if (block.type === "remote_browser") {
          return (
            <div key={key} className="min-w-0">
              {block.title ? <p className="mb-1.5 text-xs font-medium">{block.title}</p> : null}
              <RemoteBrowserCard
                url={block.url}
                expiresAt={block.expires_at ?? undefined}
                ttlMinutes={block.ttl_minutes}
                closed={block.closed}
              />
            </div>
          );
        }

        const isImage = block.type === "image";
        const isFile = block.type === "file";
        const filename = isFile
          ? block.filename
          : isImage
            ? (block.filename ?? block.caption ?? "image")
            : "voice message";
        const mime = block.mime ?? (isImage ? "image/*" : block.type === "voice" ? "audio/webm" : undefined);
        const caption = block.type === "voice" ? block.transcript : block.caption;
        return (
          <div key={key} className="min-w-0">
            {isImage && block.alt ? <span className="sr-only">{block.alt}</span> : null}
            <MediaAttachment
              mediaId={block.media_id}
              mime={mime}
              filename={filename}
              caption={caption}
              width={isImage ? block.width : undefined}
              height={isImage ? block.height : undefined}
              roomId={roomId}
              eventId={eventId}
            />
          </div>
        );
      })}
    </div>
  );
}
