"use client";

import * as React from "react";

import { toast } from "sonner";

import { identiconSvg, identiconAscii, type MarkFamily } from "@/lib/avatar";
import { copyText } from "@/lib/clipboard";
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
  const svg = React.useMemo(() => identiconSvg(seed || "?", size, family), [seed, size, family]);
  const ascii = React.useMemo(
    () => (variant === "ascii" ? identiconAscii(seed || "?", family) : ""),
    [variant, seed, family],
  );
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

  // §0g — right-click any avatar to copy its mark as ASCII, perfect for pasting
  // a silicon identity into a terminal / README.
  const onContextMenu = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      void copyText(identiconAscii(seed || "?", family)).then((ok) => {
        if (ok) toast.success("mark copied");
      });
    },
    [seed, family],
  );

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
        onContextMenu={onContextMenu}
      />
    );
  }
  if (variant === "ascii") {
    return (
      <pre
        aria-hidden
        onContextMenu={onContextMenu}
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
    <span
      aria-hidden
      onContextMenu={onContextMenu}
      style={style}
      className={cn("inline-block shrink-0 overflow-hidden border", className)}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
