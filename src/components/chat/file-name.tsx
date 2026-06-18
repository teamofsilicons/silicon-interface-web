import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Filename with a MIDDLE ellipsis so both the start and the end (crucially the
 * extension) stay visible when space is tight — e.g.
 * "dokumen.pub_pitch-anything-an-inn…0938.epub".
 *
 * Pure CSS `truncate` can only ellipsize the end. We instead split the name
 * into a head (which truncates + shows the "…") and a fixed tail that never
 * shrinks. The parent must give this a bounded width (it renders as a flexbox
 * row that fills its container).
 */
export function FileName({
  name,
  tailChars = 12,
  className,
}: {
  name: string;
  /** How many trailing characters to always keep visible. */
  tailChars?: number;
  className?: string;
}) {
  // Short enough to fit comfortably — no need to split, a plain truncate is
  // fine and avoids an awkward "…" right next to the start.
  if (name.length <= tailChars + 4) {
    return (
      <span className={cn("block truncate", className)} title={name}>
        {name}
      </span>
    );
  }
  const head = name.slice(0, name.length - tailChars);
  const tail = name.slice(name.length - tailChars);
  return (
    <span className={cn("flex min-w-0 max-w-full", className)} title={name}>
      <span className="min-w-0 truncate">{head}</span>
      <span className="shrink-0 whitespace-pre">{tail}</span>
    </span>
  );
}
