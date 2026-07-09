"use client";

import * as React from "react";
import { PaperPlaneRight } from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import { useRoomSend } from "@/components/chat/room-send-context";
import { cn } from "@/lib/utils";

export function PreviewModalComposer({ replyToEventId, onSent }: { replyToEventId?: string; onSent?: () => void }) {
  const roomSend = useRoomSend();
  const [text, setText] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const statusId = React.useId();

  if (!roomSend) return null;

  const body = text.trim();
  const textareaRows = Math.min(Math.max(text.split("\n").length, 1), 5);

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
    <div className="border-t bg-background p-3 sm:p-4">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {error ?? (sending ? "Sending..." : "")}
      </div>
      <label htmlFor="preview-modal-message" className="sr-only">
        Message while viewing preview
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
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
          rows={textareaRows}
          className="max-h-32 min-h-11 flex-1 resize-y overflow-y-auto border bg-card px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-foreground disabled:opacity-60"
        />
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!body || sending || roomSend.readOnly}
          aria-label="Send message"
          className="min-h-11 shrink-0"
        >
          <PaperPlaneRight className="mr-1 h-4 w-4" />
          {sending ? "Sending..." : "Send message"}
        </Button>
      </div>
      <div
        id={statusId}
        className={cn("mt-2 min-h-4 text-xs", error ? "text-destructive" : "text-muted-foreground")}
      >
        {roomSend.readOnly
          ? "This room is read-only."
          : error ?? "Enter sends. Shift+Enter adds a new line."}
      </div>
    </div>
  );
}
