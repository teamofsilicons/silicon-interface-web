import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Filename with a literal MIDDLE ellipsis so both the start and the end
 * (crucially the extension) stay visible — e.g. "jetbrains10293.pdf" →
 * "jet…293.pdf", "dokumen.pub_pitch-anything…0938.epub".
 *
 * The "…" is inserted into the string itself (not a CSS overflow ellipsis, which
 * only appears on overflow and so never showed for names that happened to fit).
 * A `truncate` is still applied as a safety net for absurdly narrow containers.
 */
export function FileName({
  name,
  head = 8,
  tail = 10,
  className,
}: {
  name: string;
  /** Leading characters to keep. */
  head?: number;
  /** Trailing characters to keep (includes the extension). */
  tail?: number;
  className?: string;
}) {
  const display =
    name.length > head + tail + 1
      ? `${name.slice(0, head).trimEnd()}…${name.slice(-tail)}`
      : name;
  return (
    <span className={cn("block truncate", className)} title={name}>
      {display}
    </span>
  );
}
