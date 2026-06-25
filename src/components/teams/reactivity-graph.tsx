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
const PAD_Y = 8;
const REFRESH_MS = 15000;

/** Bucket switcher — rendered top-right of the KPI card. */
export function ReactivityBucketToggle({
  bucket,
  onChange,
  className,
}: {
  bucket: ReactivityBucket;
  onChange: (b: ReactivityBucket) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      {BUCKETS.map((b) => (
        <button
          key={b.id}
          type="button"
          onClick={() => onChange(b.id)}
          className={cn(
            "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
            bucket === b.id
              ? "bg-[var(--terminal-accent)] text-[var(--terminal-bg)]"
              : "text-[var(--terminal-accent)] opacity-50 hover:opacity-100",
          )}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

function buildPaths(points: ReactivityPoint[]): { line: string; area: string } | null {
  if (points.length < 2) return null;
  const cums = points.map((p) => p.cumulative);
  const min = Math.min(...cums);
  const max = Math.max(...cums);
  const span = max - min || 1;
  const stepX = VIEW_W / (points.length - 1);

  const xy = points.map((p, i) => {
    const x = i * stepX;
    const y = VIEW_H - PAD_Y - ((p.cumulative - min) / span) * (VIEW_H - PAD_Y * 2);
    return [x, y] as const;
  });

  const line = xy.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${VIEW_W} ${VIEW_H} L0 ${VIEW_H} Z`;
  return { line, area };
}

function fmtTick(iso: string, bucket: ReactivityBucket): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (bucket === "hour") return d.toLocaleTimeString([], { hour: "numeric" });
  if (bucket === "day") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { month: "short" });
}

/** Up to four evenly spaced x-axis time labels. */
function tickLabels(points: ReactivityPoint[], bucket: ReactivityBucket): string[] {
  if (points.length < 2) return [];
  const last = points.length - 1;
  const idx = [...new Set([0, Math.round(last / 3), Math.round((2 * last) / 3), last])];
  return idx.map((i) => fmtTick(points[i].t, bucket));
}

/**
 * Cumulative reactivity over time. Full-width line, no animation — it just
 * reflects the latest series, refreshing live as new points are polled.
 */
export function ReactivityGraph({
  slug,
  bucket,
  className,
}: {
  slug: string;
  bucket: ReactivityBucket;
  className?: string;
}) {
  const [points, setPoints] = React.useState<ReactivityPoint[]>([]);

  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.teamReactivitySeries(slug, bucket);
        if (alive) setPoints(r.points);
      } catch {
        /* keep whatever we last drew */
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
  const ticks = React.useMemo(() => tickLabels(points, bucket), [points, bucket]);

  const baseline = points.length ? points[0].cumulative : 0;
  const peak = points.length ? points[points.length - 1].cumulative : 0;
  const delta = peak - baseline;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="relative">
        {/* Activity added across the visible window. */}
        {paths && delta > 0 && (
          <div className="absolute left-0 top-0 font-mono text-[10px] text-[var(--terminal-accent)]">
            ▲ {delta.toLocaleString()}
          </div>
        )}
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
            // Flat full-width baseline while empty / loading.
            <line
              x1={0}
              y1={VIEW_H / 2}
              x2={VIEW_W}
              y2={VIEW_H / 2}
              stroke="var(--terminal-accent)"
              strokeOpacity={0.25}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>

      <div className="flex justify-between font-mono text-[10px] text-[var(--terminal-accent)] opacity-60">
        {ticks.length ? (
          ticks.map((label, i) => <span key={`${label}-${i}`}>{label}</span>)
        ) : (
          <>
            <span>{rangeLabel(bucket)}</span>
            <span>now</span>
          </>
        )}
      </div>
    </div>
  );
}

function rangeLabel(bucket: ReactivityBucket): string {
  if (bucket === "hour") return "last 24 hours";
  if (bucket === "day") return "last 30 days";
  return "last 12 months";
}
