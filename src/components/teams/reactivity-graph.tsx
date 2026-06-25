"use client";

import * as React from "react";

import { api, type ReactivityBucket, type ReactivityPoint } from "@/lib/api";
import { cn } from "@/lib/utils";

const BUCKETS: { id: ReactivityBucket; label: string }[] = [
  { id: "hour", label: "hour" },
  { id: "day", label: "date" },
  { id: "month", label: "month" },
];

const VIEW_W = 320;
const VIEW_H = 96;
const PAD_X = 6;
const PAD_Y = 10;
const REFRESH_MS = 15000;

function buildPaths(points: ReactivityPoint[]): { line: string; area: string } | null {
  if (points.length < 2) return null;
  const cums = points.map((p) => p.cumulative);
  const min = Math.min(...cums);
  const max = Math.max(...cums);
  const span = max - min || 1;
  const stepX = (VIEW_W - PAD_X * 2) / (points.length - 1);

  const xy = points.map((p, i) => {
    const x = PAD_X + i * stepX;
    const y = VIEW_H - PAD_Y - ((p.cumulative - min) / span) * (VIEW_H - PAD_Y * 2);
    return [x, y] as const;
  });

  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [firstX] = xy[0];
  const [lastX] = xy[xy.length - 1];
  const area = `${line} L${lastX.toFixed(1)} ${VIEW_H - PAD_Y} L${firstX.toFixed(1)} ${VIEW_H - PAD_Y} Z`;
  return { line, area };
}

/**
 * Cumulative reactivity over time. The line draws itself in on first load and
 * whenever the granularity changes, then extends as new points are polled.
 */
export function ReactivityGraph({ slug, className }: { slug: string; className?: string }) {
  const [bucket, setBucket] = React.useState<ReactivityBucket>("hour");
  const [points, setPoints] = React.useState<ReactivityPoint[]>([]);
  const [loaded, setLoaded] = React.useState(false);

  const lineRef = React.useRef<SVGPathElement>(null);
  const animatedBucket = React.useRef<ReactivityBucket | null>(null);
  const [animTick, setAnimTick] = React.useState(0);

  // Fetch the series for the active bucket, then keep it fresh.
  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.teamReactivitySeries(slug, bucket);
        if (!alive) return;
        setPoints(r.points);
        setLoaded(true);
        // Replay the draw animation when this bucket's data first lands.
        if (animatedBucket.current !== bucket) {
          animatedBucket.current = bucket;
          setAnimTick((t) => t + 1);
        }
      } catch {
        if (alive) setLoaded(true); // show whatever we have; don't spin forever
      }
    };
    void tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [slug, bucket]);

  const paths = React.useMemo(() => buildPaths(points), [points]);

  // Draw-in animation: dash the line to its full length, then unspool it.
  React.useLayoutEffect(() => {
    const el = lineRef.current;
    if (!el || !paths) return;
    const len = el.getTotalLength();
    el.style.transition = "none";
    el.style.strokeDasharray = `${len}`;
    el.style.strokeDashoffset = `${len}`;
    void el.getBoundingClientRect(); // force reflow so the reset takes
    el.style.transition = "stroke-dashoffset 900ms ease-out";
    el.style.strokeDashoffset = "0";
  }, [animTick, paths]);

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between">
        <span className="label-mono text-[var(--terminal-accent)]">reactivity over time</span>
        <div className="flex items-center gap-1">
          {BUCKETS.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setBucket(b.id)}
              className={cn(
                "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
                bucket === b.id
                  ? "bg-[var(--terminal-accent)] text-[var(--terminal-bg)]"
                  : "text-[var(--terminal-accent)] opacity-60 hover:opacity-100",
              )}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        className="h-24 w-full"
        role="img"
        aria-label="Cumulative reactivity over time"
      >
        <defs>
          <linearGradient id="reactivity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--terminal-accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--terminal-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {paths ? (
          <>
            <path d={paths.area} fill="url(#reactivity-fill)" stroke="none" />
            <path
              ref={lineRef}
              d={paths.line}
              fill="none"
              stroke="var(--terminal-accent)"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </>
        ) : (
          // Flat baseline while empty / loading so the panel keeps its shape.
          <line
            x1={PAD_X}
            y1={VIEW_H - PAD_Y}
            x2={VIEW_W - PAD_X}
            y2={VIEW_H - PAD_Y}
            stroke="var(--terminal-accent)"
            strokeOpacity={0.25}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      <div className="flex items-center justify-between font-mono text-[10px] text-[var(--terminal-accent)] opacity-70">
        <span>{rangeLabel(bucket)}</span>
        <span>{!loaded ? "loading…" : paths ? "now" : "no activity yet"}</span>
      </div>
    </div>
  );
}

function rangeLabel(bucket: ReactivityBucket): string {
  if (bucket === "hour") return "last 24 hours";
  if (bucket === "day") return "last 30 days";
  return "last 12 months";
}
