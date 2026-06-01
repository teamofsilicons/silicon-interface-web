"use client";

import * as React from "react";
import { GlobeHemisphereWest } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

/**
 * A silicon-sent, time-limited link to a remote browser session. Renders a
 * Silicon-styled card with a circular countdown ring (the ring shrinks as time
 * runs out). Once expired it's no longer clickable; otherwise it opens _blank.
 */
export function RemoteBrowserCard({
  url,
  expiresAt,
  ttlMinutes,
}: {
  url: string;
  expiresAt?: string;
  ttlMinutes?: number;
}) {
  // Tick every second so the ring glides; the minute label updates each minute.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const expMs = expiresAt ? Date.parse(expiresAt) : 0;
  const totalMs = (ttlMinutes ?? 60) * 60_000;
  const remainMs = expMs ? Math.max(0, expMs - now) : 0;
  const expired = !expMs || remainMs <= 0;
  const frac = totalMs > 0 ? Math.max(0, Math.min(1, remainMs / totalMs)) : 0;
  const minutesLeft = Math.ceil(remainMs / 60_000);

  // Ring geometry.
  const size = 48;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - frac);

  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    /* leave as-is */
  }

  const card = (
    <div className={cn("w-64 max-w-full space-y-2 border bg-card p-3 text-foreground", expired && "opacity-60")}>
      <div className="flex items-center gap-2">
        <GlobeHemisphereWest className="h-4 w-4 shrink-0" />
        <span className="text-sm font-medium">Remote Browser</span>
      </div>
      <div className="truncate text-xs text-muted-foreground" title={url}>
        {host}
      </div>
      <span className="label-mono text-[10px] tracking-wide text-muted-foreground">
        SILICON BROWSER
      </span>

      <div className="flex flex-col items-center gap-1 pt-1">
        <div className="relative inline-flex items-center justify-center">
          <svg width={size} height={size} className="-rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              className="opacity-15"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={offset}
              className="transition-[stroke-dashoffset] duration-1000 ease-linear"
            />
          </svg>
          <span className="absolute label-mono text-[10px] font-medium">
            {expired ? "0" : `${minutesLeft}m`}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {expired ? "link expired" : "expires soon"}
        </span>
      </div>
    </div>
  );

  if (expired) return card;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block transition-opacity hover:opacity-90"
    >
      {card}
    </a>
  );
}
