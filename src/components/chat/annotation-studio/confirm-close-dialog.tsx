"use client";

import * as React from "react";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";

interface Props {
  /** How many committed-but-unattached annotations exist. */
  count: number;
  /** Dismiss the confirm and return to editing. */
  onKeepEditing: () => void;
  /** Close the studio; the draft stays autosaved and restores on reopen. */
  onClose: () => void;
  /** Attach to chat (Milestone 5). When omitted, the button is hidden. */
  onAttach?: () => void;
}

/**
 * Anti-loss guard shown when the studio is closed with unattached annotations.
 * Rendered as an in-studio overlay (scrim + centered card) rather than a nested
 * Radix dialog, so it never fights the studio modal's focus trap.
 *
 * "Close" leaves the autosave intact — the work is recoverable on reopen — so
 * there's no way to silently lose annotations.
 */
export function ConfirmCloseDialog({ count, onKeepEditing, onClose, onAttach }: Props) {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label="unattached annotations"
    >
      <div className="w-[min(92%,420px)] border bg-background p-4 shadow-lg">
        <div className="flex items-start gap-3">
          <WarningCircle className="mt-0.5 h-5 w-5 shrink-0 text-foreground" />
          <div>
            <p className="text-sm font-medium">
              {count} annotation{count === 1 ? "" : "s"} not attached yet
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              they&rsquo;re saved as a draft and will be here when you reopen this
              attachment. attach them to the chat to send them to the silicon.
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="close annotation studio">
            close
          </Button>
          <Button size="sm" variant="outline" onClick={onKeepEditing} aria-label="keep editing annotations">
            keep editing
          </Button>
          {onAttach && (
            <Button size="sm" onClick={onAttach} aria-label="attach annotations to chat">
              attach to chat
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
