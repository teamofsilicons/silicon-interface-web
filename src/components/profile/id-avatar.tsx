"use client";

import * as React from "react";

import { identiconSvg, type MarkFamily } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/** Square avatar: uploaded photo if present, else a deterministic MarkSystem glyph. */
export function IdAvatar({
  seed,
  src,
  asciiSrc,
  size = 40,
  family = "carbon",
  className,
}: {
  seed: string;
  src?: string | null;
  /** Delights §0a — colored ASCII "Silicon Treatment" of the photo. Preferred
   *  over the raw photo when present so every avatar carries the terminal look. */
  asciiSrc?: string | null;
  size?: number;
  family?: MarkFamily;
  className?: string;
}) {
  const svg = React.useMemo(() => identiconSvg(seed || "?", size, family), [seed, size, family]);
  const style = { width: size, height: size };
  const effective = asciiSrc || src;

  // QA §7.6: presigned S3 photo URLs expire. Without an onError handler an
  // expired (or otherwise broken) URL renders the browser's broken-image icon
  // instead of the deterministic glyph we already computed. Track load failure
  // and fall back to the glyph. Reset whenever the src changes so a fresh URL
  // gets another chance.
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setFailed(false);
  }, [effective]);

  if (effective && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- presigned S3 URL, not a static asset
      <img
        src={effective}
        alt=""
        aria-hidden
        width={size}
        height={size}
        style={style}
        className={cn("shrink-0 border object-cover", className)}
        onError={() => setFailed(true)}
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
