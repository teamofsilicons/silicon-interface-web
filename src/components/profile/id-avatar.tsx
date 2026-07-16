"use client";

import * as React from "react";

import { identiconDataUrl, identiconAscii, type MarkFamily } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/** Square avatar: uploaded photo if present, else a deterministic MarkSystem glyph. */
export function IdAvatar({
  seed,
  src,
  asciiSrc,
  size = 40,
  family = "carbon",
  variant = "mark",
  className,
}: {
  seed: string;
  src?: string | null;
  /** Delights §0a — colored ASCII "Silicon Treatment" of the photo. Preferred
   *  over the raw photo when present so every avatar carries the terminal look. */
  asciiSrc?: string | null;
  size?: number;
  family?: MarkFamily;
  /** §0b — "ascii" renders the glyph itself as monospace ASCII instead of SVG. */
  variant?: "mark" | "ascii";
  className?: string;
}) {
  const markSrc = React.useMemo(
    () => identiconDataUrl(seed || "?", size, family),
    [seed, size, family],
  );
  const ascii = React.useMemo(
    () => (variant === "ascii" ? identiconAscii(seed || "?", family) : ""),
    [variant, seed, family],
  );
  const style = { width: size, height: size };
  // Show the uploaded photo as-is. (`asciiSrc` is accepted but no longer
  // preferred — the ASCII-pfp treatment was reverted to normal photos.)
  void asciiSrc;
  const effective = src;

  // QA §7.6: presigned S3 photo URLs expire. Without an onError handler an
  // expired (or otherwise broken) URL renders the browser's broken-image icon
  // instead of the deterministic glyph we already computed. Track load failure
  // and fall back to the glyph. Key the failure by URL so a fresh presigned URL
  // always gets its own load attempt without synchronizing state in an effect.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const failed = effective === failedSrc;

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
        className={cn("sdr-media shrink-0 border object-cover", className)}
        onError={() => setFailedSrc(effective)}
      />
    );
  }
  if (variant === "ascii") {
    return (
      <pre
        aria-hidden
        style={{ ...style, fontSize: size / 7, lineHeight: 1 }}
        className={cn(
          "m-0 grid shrink-0 place-items-center overflow-hidden border bg-background font-mono text-foreground",
          className,
        )}
      >
        {ascii}
      </pre>
    );
  }
  return (
    // A generated logo is an immutable, self-contained image. Rendering its
    // SVG markup directly in the page allowed duplicate SVG IDs to interfere
    // across repeated instances of the same team.
    // eslint-disable-next-line @next/next/no-img-element -- generated data URL; no network optimization applies
    <img
      src={markSrc}
      alt=""
      aria-hidden
      width={size}
      height={size}
      style={style}
      // §0e — a subtle "breathe" on hover. transform-only (no reflow); stilled
      // under reduced-motion.
      className={cn(
        "block shrink-0 overflow-hidden border motion-safe:transition-transform motion-safe:duration-300 motion-safe:hover:scale-[1.06]",
        className,
      )}
    />
  );
}
