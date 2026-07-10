"use client";

import * as React from "react";
import { WarningCircle } from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";

interface Props {
  /** How many committed-but-unattached annotations exist. */
  count: number;
  /** Dismiss the confirm and return to editing. */
  onKeepEditing: () => void;
  /** Permanently discard this unfinished annotation draft. */
  onDiscard: () => void;
}

/**
 * Anti-loss guard shown when the studio is closed with unattached annotations.
 * Rendered as an in-studio overlay (scrim + centered card) rather than a nested
 * Radix dialog, so it never fights the studio modal's focus trap.
 *
 * Closing is an explicit two-way decision: discard or keep editing.
 */
export function ConfirmCloseDialog({ count, onKeepEditing, onDiscard }: Props) {
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
            <p className="mt-1 text-xs text-foreground">
              discarding removes this unfinished draft. keep editing to return
              to the document.
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onDiscard} aria-label="discard annotations">
            discard
          </Button>
          <Button size="sm" onClick={onKeepEditing} aria-label="keep editing annotations">
            keep editing
          </Button>
        </div>
      </div>
    </div>
  );
}
