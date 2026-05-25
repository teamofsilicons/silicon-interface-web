"use client";

import * as React from "react";
import { File, Image as ImageIcon, MoreHorizontal, Music, Sparkles, Trash2 } from "lucide-react";

import type { Event, ProgressState } from "@/lib/types";
import { cn, relativeTime, shortId } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface Props {
  event: Event;
  isMine: boolean;
  isOwnSilicon?: boolean;
  onTakeBack?: (eventId: string, force?: boolean) => void;
}

export function MessageBubble({ event, isMine, isOwnSilicon, onTakeBack }: Props) {
  if (event.type === "m.system") {
    return (
      <div className="my-2 flex justify-center">
        <Badge variant="secondary">{String(event.content.body ?? "system event")}</Badge>
      </div>
    );
  }
  if (event.type === "m.session_marker") {
    const action = String(event.content.action ?? "new");
    return (
      <div className="my-4 flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <div className="text-xs text-muted-foreground">
          session {action} {event.content.summary ? `· ${event.content.summary}` : ""}
        </div>
        <div className="h-px flex-1 bg-border" />
      </div>
    );
  }
  if (event.type === "m.progress" && event.content.state === "done") {
    return (
      <div className="my-2 flex items-start gap-2">
        <Sparkles className="mt-1 h-4 w-4 text-primary" />
        <div className="text-sm">
          <div className="font-medium">silicon finished</div>
          {event.content.summary ? (
            <div className="text-muted-foreground">{String(event.content.summary)}</div>
          ) : null}
        </div>
      </div>
    );
  }

  const redacted = event.redacted_at !== null;
  // Prefer the sender's handle (carbon username == carbon_id, or silicon name);
  // fall back to the kind only if we don't have it (e.g. system events).
  const senderLabel = event.sender_handle
    ? `@${event.sender_handle}`
    : event.sender_kind === "silicon"
      ? "silicon"
      : event.sender_kind === "carbon"
        ? "carbon"
        : "system";
  const avatarText = event.sender_handle
    ? event.sender_handle.slice(0, 2).toUpperCase()
    : event.sender_kind === "silicon"
      ? "Si"
      : "Cb";

  return (
    <div className={cn("my-1.5 flex w-full gap-2", isMine ? "justify-end" : "justify-start")}>
      {!isMine && (
        <div className="mt-1 flex h-7 w-7 items-center justify-center rounded-full bg-secondary text-[10px] font-medium">
          {avatarText}
        </div>
      )}
      <div className={cn("max-w-[70%] space-y-1", isMine && "items-end")}>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>{senderLabel}</span>
          <span>·</span>
          <span>{relativeTime(event.created_at)}</span>
          {!event.is_final && <span className="text-primary">streaming…</span>}
        </div>
        <div
          className={cn(
            "group relative rounded-lg px-3 py-2 text-sm",
            redacted
              ? "border bg-muted text-muted-foreground italic"
              : isMine
                ? "bg-primary text-primary-foreground"
                : "border bg-card",
          )}
        >
          {redacted ? (
            <span>[message redacted: {event.redaction_reason}]</span>
          ) : (
            <Body event={event} />
          )}
          {isMine && isOwnSilicon && !redacted && onTakeBack && (
            <div className="absolute right-1 top-1 opacity-0 transition-opacity group-hover:opacity-100">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-6 w-6 text-primary-foreground/80">
                    <MoreHorizontal className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onTakeBack(event.event_id)}>
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    take back (if unread)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onTakeBack(event.event_id, true)}>
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    take back (force)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Body({ event }: { event: Event }) {
  const c = event.content;
  switch (event.type) {
    case "m.text":
      return <div className="whitespace-pre-wrap break-words">{String(c.body ?? "")}</div>;
    case "m.image":
      return (
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4" />
          <span className="text-xs">
            image · {shortId(String(c.media_id ?? ""))}
            {c.caption ? ` · ${c.caption}` : ""}
          </span>
        </div>
      );
    case "m.file":
      return (
        <div className="flex items-center gap-2">
          <File className="h-4 w-4" />
          <span className="text-xs">
            file · {shortId(String(c.media_id ?? ""))}
            {c.caption ? ` · ${c.caption}` : ""}
          </span>
        </div>
      );
    case "m.voice":
      return (
        <div className="flex items-center gap-2">
          <Music className="h-4 w-4" />
          <div className="text-xs">
            <div>voice note · {shortId(String(c.media_id ?? ""))}</div>
            {c.transcript ? (
              <div className="text-muted-foreground">“{String(c.transcript)}”</div>
            ) : null}
          </div>
        </div>
      );
    case "m.tts":
      return (
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          <div className="text-xs">
            <div>
              tts · voice {String(c.voice ?? "?")} · provider {String(c.provider ?? "?")}
            </div>
            <div className="italic">“{String(c.text ?? "")}”</div>
          </div>
        </div>
      );
    case "m.progress": {
      const state = (c.state as ProgressState) || "thinking";
      return (
        <div className="flex items-center gap-2 text-xs">
          <Sparkles className="h-3.5 w-3.5" />
          <span>{state.replaceAll("_", " ")}</span>
          {c.note ? <span className="text-muted-foreground">· {String(c.note)}</span> : null}
        </div>
      );
    }
    default:
      return <pre className="text-xs">{JSON.stringify(c, null, 2)}</pre>;
  }
}
