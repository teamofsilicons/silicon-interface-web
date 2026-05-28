"use client";

import * as React from "react";

import { identiconSvg } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/** Square avatar: the uploaded photo if present, else a deterministic jdenticon
 *  derived from the handle (the same mark generated at sign-up). */
export function IdAvatar({
  seed,
  src,
  size = 40,
  className,
}: {
  seed: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const svg = React.useMemo(() => identiconSvg(seed || "?", size), [seed, size]);
  const style = { width: size, height: size };

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URL, not a static asset
      <img
        src={src}
        alt=""
        aria-hidden
        width={size}
        height={size}
        style={style}
        className={cn("shrink-0 border object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={style}
      className={cn("inline-block shrink-0 overflow-hidden border", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
