"use client";

import * as React from "react";
import { PaperPlaneRight } from "@phosphor-icons/react/dist/ssr";

import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * A lightweight chat surface for the Create Team wizard's conversational steps
 * (server setup agent + architecture architect). Not the heavy RoomView — just
 * a scrolling transcript of square bubbles plus a composer, matching the design
 * system. The parent owns the transcript and send handler.
 */
export function SetupChat({
  turns,
  busy,
  onSend,
  placeholder = "Type a message…",
  disabled = false,
  className,
}: {
  turns: ChatTurn[];
  busy?: boolean;
  onSend: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  const submit = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    onSend(text);
    setDraft("");
  };

  return (
    <div className={cn("flex h-full flex-col border bg-card", className)}>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {turns.length === 0 && !busy && (
          <p className="text-sm text-muted-foreground">{placeholder}</p>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}
          >
            <div
              className={cn(
                "max-w-[85%] whitespace-pre-wrap break-words px-3 py-2 text-sm",
                t.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "border bg-[color:var(--bubble-received)] text-foreground",
              )}
            >
              {t.role === "assistant" ? (
                <div className="prose-chat">{renderMarkdown(t.text)}</div>
              ) : (
                t.text
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner /> thinking…
          </div>
        )}
      </div>
      <div className="flex items-end gap-2 border-t p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <Button size="icon" onClick={submit} disabled={disabled || !draft.trim()} aria-label="Send">
          <PaperPlaneRight weight="fill" />
        </Button>
      </div>
    </div>
  );
}
