"use client";

import * as React from "react";
import confetti from "canvas-confetti";
import { Confetti } from "@phosphor-icons/react/dist/ssr";

import { buildRealisticConfettiBursts } from "@/lib/work-confetti";
import { cn } from "@/lib/utils";

export interface WorkConfettiButtonProps {
  className?: string;
  label?: string;
}

/** Replayable viewport-wide realistic confetti with reduced-motion support. */
export function WorkConfettiButton({
  className,
  label = "Celebrate completion",
}: WorkConfettiButtonProps) {
  const [celebrating, setCelebrating] = React.useState(false);
  const statusTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => () => {
    if (statusTimeoutRef.current !== null) {
      window.clearTimeout(statusTimeoutRef.current);
    }
    confetti.reset();
  }, []);

  const celebrate = () => {
    setCelebrating(true);
    if (statusTimeoutRef.current !== null) {
      window.clearTimeout(statusTimeoutRef.current);
    }
    statusTimeoutRef.current = window.setTimeout(() => {
      setCelebrating(false);
      statusTimeoutRef.current = null;
    }, 2_500);

    for (const burst of buildRealisticConfettiBursts()) {
      void confetti({
        ...burst,
        zIndex: 90,
        disableForReducedMotion: true,
      });
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={celebrate}
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center border-l text-foreground transition-colors hover:bg-accent",
          className,
        )}
        aria-label={label}
        title={label}
      >
        <Confetti className="h-4 w-4" weight="fill" aria-hidden />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {celebrating ? "Celebrating task completion" : ""}
      </span>
    </>
  );
}
