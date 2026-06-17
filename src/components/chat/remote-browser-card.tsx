"use client";

import * as React from "react";
import { ArrowUpRight, GlobeHemisphereWest } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

/**
 * A silicon-sent, time-limited link to a Silicon Browser session. Renders a
 * Silicon-styled card with a circular countdown ring (the ring drains as time
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
  const expMs = expiresAt ? Date.parse(expiresAt) : 0;
  const validExp = expMs > 0 && Number.isFinite(expMs);

  // Tick every second so the ring glides; the minute label updates each minute.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    // Don't tick forever. Once the link is expired (or has no valid expiry)
    // there's nothing to animate — a permanent 1s interval is wasted work.
    if (!validExp) return;
    if (now >= expMs) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [validExp, expMs, now]);

  const totalMs = (ttlMinutes ?? 60) * 60_000;
  const remainMs = validExp ? Math.max(0, expMs - now) : 0;
  const expired = !validExp || remainMs <= 0;
  const frac = totalMs > 0 ? Math.max(0, Math.min(1, remainMs / totalMs)) : 0;
  const minutesLeft = Math.ceil(remainMs / 60_000);
  // "expires soon" should mean something — only flag it near the end. Otherwise
  // show the actual remaining time so the label tracks the ring.
  const expiresSoon = !expired && remainMs <= 5 * 60_000;

  // Ring geometry — a generous, legible dial.
  const size = 84;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - frac);

  // Only http(s) links are clickable — refuse javascript:/data:/file: so a
  // silicon-sent card can never become an injection vector.
  let host = url;
  let safeUrl: string | null = null;
  try {
    const u = new URL(url);
    host = u.host || url;
    if (u.protocol === "http:" || u.protocol === "https:") safeUrl = url;
  } catch {
    /* leave host as-is; safeUrl stays null → non-clickable */
  }

  const clickable = !expired && !!safeUrl;

  const statusText = expired
    ? "link expired"
    : expiresSoon
      ? "expires soon"
      : `expires in ${minutesLeft}m`;

  const card = (
    <div
      className={cn(
        "group/sb w-72 max-w-full overflow-hidden border bg-card text-foreground transition-colors",
        expired ? "opacity-60" : "group-hover/sb:border-foreground/40",
      )}
    >
      {/* Header — icon badge, title, and a live/expired status dot. */}
      <div className="flex items-center gap-3 border-b px-3.5 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center border bg-background">
          <GlobeHemisphereWest className="h-4 w-4" weight="regular" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-medium leading-none">
            Silicon Browser
            {clickable && (
              <ArrowUpRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover/sb:opacity-60" />
            )}
          </div>
          <div className="mt-1 truncate text-xs text-muted-foreground" title={url}>
            {host}
          </div>
        </div>
        <span
          aria-hidden
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            expired
              ? "bg-muted-foreground/40"
              : expiresSoon
                ? "bg-foreground"
                : "bg-foreground animate-pulse motion-reduce:animate-none",
          )}
        />
      </div>

      {/* Countdown dial. */}
      <div className="flex flex-col items-center gap-2 px-3.5 py-4">
        <div className="relative inline-flex items-center justify-center">
          <svg width={size} height={size} className="-rotate-90">
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              className="opacity-10"
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
          <div className="absolute flex flex-col items-center leading-none">
            <span className="text-lg font-semibold tabular-nums">{expired ? "0" : minutesLeft}</span>
            <span className="label-mono mt-0.5 text-[9px] tracking-widest text-muted-foreground">
              {expired ? "DONE" : "MIN LEFT"}
            </span>
          </div>
        </div>
        <span
          className={cn(
            "text-[11px]",
            expiresSoon ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {statusText}
        </span>
      </div>

      {/* Footer tag. */}
      <div className="flex items-center gap-1.5 border-t px-3.5 py-2">
        <span className="h-1 w-1 shrink-0 bg-muted-foreground/60" />
        <span className="label-mono text-[10px] tracking-wide text-muted-foreground">
          SILICON BROWSER SESSION
        </span>
      </div>
    </div>
  );

  // Non-clickable when expired or the scheme isn't http(s). The hover affordance
  // lives on the `group/sb` so only the real link reacts.
  if (!clickable) return card;
  return (
    <a href={safeUrl!} target="_blank" rel="noopener noreferrer" className="group/sb block">
      {card}
    </a>
  );
}
