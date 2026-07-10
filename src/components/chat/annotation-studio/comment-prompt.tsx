"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";

interface Props {
  /** Optional starting text (editing an existing annotation's comment). */
  initial?: string;
  /** Label of the annotation being commented, e.g. "new markup" or "A2". */
  title?: string;
  onSubmit: (comment: string) => void;
  onCancel: () => void;
  onAddMarkup?: (commentDraft: string) => void;
  markupCount?: number;
}

export const COMMENT_PROMPT_WIDTH = 300;

/**
 * The required-comment gate. Shown after a markup is drawn (or when editing an
 * existing annotation's comment). A non-empty comment is mandatory — the primary
 * button stays disabled until there's text. Enter submits, Shift+Enter adds a
 * newline, Escape cancels (which discards the pending markup upstream).
 *
 * Renders just the card — the stage positions it as a popover next to the
 * markup. It's a plain card (not a nested dialog) so it never steals the studio
 * modal's focus trap.
 */
export function CommentPrompt({
  initial = "",
  title = "new markup",
  onSubmit,
  onCancel,
  onAddMarkup,
  markupCount = 1,
}: Props) {
  const [text, setText] = React.useState(initial);
  const ref = React.useRef<HTMLTextAreaElement | null>(null);

  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const trimmed = text.trim();
  const submit = () => {
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <div
      className="pointer-events-auto border bg-background p-3 shadow-lg"
      style={{ width: COMMENT_PROMPT_WIDTH }}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="label-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          comment · {title}
        </span>
        <span className="text-[11px] text-muted-foreground">required</span>
      </div>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          // Escape is handled at the dialog level (cancels the comment without
          // closing the whole studio).
        }}
        rows={2}
        aria-label="annotation comment"
        placeholder="what should change here?"
        className="w-full resize-none border bg-card px-2 py-1.5 text-sm outline-none focus:border-foreground"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        {onAddMarkup && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAddMarkup(text)}
            aria-label="add another markup to this annotation"
          >
            add mark
            {markupCount > 1 ? ` (${markupCount})` : ""}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel} aria-label="cancel comment">
          cancel
        </Button>
        <Button size="sm" onClick={submit} disabled={!trimmed} aria-label="add annotation">
          add annotation
        </Button>
      </div>
    </div>
  );
}
