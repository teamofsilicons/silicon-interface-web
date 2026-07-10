"use client";

import * as React from "react";
import { PaperPlaneRight } from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import { useRoomSend } from "@/components/chat/room-send-context";
import { cn } from "@/lib/utils";

const MIN_COMPOSER_HEIGHT = 116;
const DEFAULT_COMPOSER_HEIGHT = 156;

function maxComposerHeight(): number {
  if (typeof window === "undefined") return 520;
  return Math.max(MIN_COMPOSER_HEIGHT, Math.min(520, Math.round(window.innerHeight * 0.6)));
}

export function PreviewModalComposer({ replyToEventId, onSent }: { replyToEventId?: string; onSent?: () => void }) {
  const roomSend = useRoomSend();
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const dragRef = React.useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [height, setHeight] = React.useState(DEFAULT_COMPOSER_HEIGHT);
  const statusId = React.useId();

  React.useEffect(() => {
    const clampToViewport = () => setHeight((current) => Math.min(current, maxComposerHeight()));
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, []);

  if (!roomSend) return null;

  const body = text.trim();
  const resizeBy = (next: number) => {
    setHeight(Math.max(MIN_COMPOSER_HEIGHT, Math.min(maxComposerHeight(), Math.round(next))));
  };

  const submit = async () => {
    if (!body || sending || roomSend.readOnly) return;
    setSending(true);
    setError(null);
    try {
      await roomSend.sendText(body, { replyToEventId });
      setText("");
      onSent?.();
      window.setTimeout(() => textareaRef.current?.focus(), 0);
    } catch {
      setError("Couldn’t send. Your message is still here.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="relative flex shrink-0 flex-col border-t bg-background"
      style={{ height }}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize preview message writer"
        aria-orientation="horizontal"
        aria-valuemin={MIN_COMPOSER_HEIGHT}
        aria-valuemax={520}
        aria-valuenow={height}
        onPointerDown={(event) => {
          dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          resizeBy(drag.startHeight + drag.startY - event.clientY);
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") resizeBy(height + 24);
          else if (event.key === "ArrowDown") resizeBy(height - 24);
          else if (event.key === "Home") resizeBy(MIN_COMPOSER_HEIGHT);
          else if (event.key === "End") resizeBy(maxComposerHeight());
          else return;
          event.preventDefault();
        }}
        className="group flex h-4 shrink-0 touch-none cursor-ns-resize items-center justify-center outline-none focus-visible:bg-muted"
      >
        <span className="h-1 w-12 bg-border transition-colors group-hover:bg-foreground group-focus-visible:bg-foreground" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-2 sm:px-4 sm:pb-3">
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {error ?? (sending ? "Sending..." : "")}
        </div>
        <label htmlFor="preview-modal-message" className="sr-only">
          Message while viewing preview
        </label>
        <div className="flex min-h-0 flex-1 flex-col gap-2 sm:flex-row sm:items-stretch">
          <textarea
            ref={textareaRef}
            id="preview-modal-message"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Message while viewing preview..."
            aria-describedby={statusId}
            disabled={roomSend.readOnly || sending}
            rows={1}
            className="min-h-11 min-w-0 flex-1 resize-none overflow-y-auto border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground disabled:opacity-60"
          />
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={!body || sending || roomSend.readOnly}
            aria-label="Send message"
            className="min-h-11 shrink-0 sm:self-end"
          >
            <PaperPlaneRight className="mr-1 h-4 w-4" />
            {sending ? "Sending..." : "Send message"}
          </Button>
        </div>
        <div
          id={statusId}
          className={cn("mt-1 min-h-4 shrink-0 text-xs", error ? "text-destructive" : "text-muted-foreground")}
        >
          {roomSend.readOnly
            ? "This room is read-only."
            : error ?? "Enter sends. Shift+Enter adds a new line."}
        </div>
      </div>
    </div>
  );
}
