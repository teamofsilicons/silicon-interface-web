"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

// Delights §1a — a terminal-flavored spinner: a braille cycle instead of a
// rounded ring, matching the ASCII soul of the product. Reduced-motion users
// get a static frame (no cycling).
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

export function Spinner({ className }: { className?: string }) {
  const [i, setI] = React.useState(0);
  React.useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return; // honor reduced-motion: hold a single frame
    }
    const id = window.setInterval(() => setI((n) => (n + 1) % FRAMES.length), 90);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span aria-hidden className={cn("inline-block font-mono leading-none", className)}>
      {FRAMES[i]}
    </span>
  );
}
