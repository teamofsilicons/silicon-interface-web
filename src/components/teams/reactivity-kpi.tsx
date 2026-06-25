"use client";

import * as React from "react";
import { Pulse } from "@phosphor-icons/react/dist/ssr";

import { api } from "@/lib/api";
import { loadLastReactivity, saveLastReactivity } from "@/lib/reactivity-cache";
import { cn } from "@/lib/utils";

import { ReactivityGraph } from "./reactivity-graph";

/**
 * The Reactivity KPI — a Silicon-trigger count Glass returns, polled every 2s.
 * The number eases toward each new value so it reads as live progress. On open
 * it seeds from the last value we showed (localStorage) and climbs from there,
 * so reactivity feels like it's continuing rather than restarting at zero.
 */
export function ReactivityKpi({ slug, className }: { slug: string; className?: string }) {
  const [target, setTarget] = React.useState(() => loadLastReactivity(slug) ?? 0);
  const [display, setDisplay] = React.useState(() => loadLastReactivity(slug) ?? 0);
  const displayRef = React.useRef(display);

  // Poll Glass every 2 seconds.
  React.useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.teamReactivity(slug);
        if (!alive) return;
        setTarget(r.value);
        saveLastReactivity(slug, r.value);
      } catch {
        /* keep the last value */
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [slug]);

  // Ease the displayed number toward the latest target.
  React.useEffect(() => {
    let raf = 0;
    const animate = () => {
      const cur = displayRef.current;
      const diff = target - cur;
      if (Math.abs(diff) < 0.5) {
        displayRef.current = target;
        setDisplay(target);
        return;
      }
      const next = cur + diff * 0.18;
      displayRef.current = next;
      setDisplay(next);
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const shown = Math.round(display);
  const climbing = target - display > 0.5;

  return (
    <div
      className={cn(
        "border bg-[var(--terminal-bg)] p-5 text-[var(--terminal-fg)]",
        className,
      )}
    >
      <div className="label-mono flex items-center gap-2 text-[var(--terminal-accent)]">
        <Pulse className="h-3.5 w-3.5" weight="fill" /> reactivity
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-mono text-4xl font-bold tabular-nums">
          {shown.toLocaleString()}
        </span>
        <span
          className={cn(
            "text-sm text-[var(--terminal-accent)] transition-opacity",
            climbing ? "opacity-100" : "opacity-0",
          )}
        >
          ▲
        </span>
      </div>
      <p className="mt-1 text-xs text-[var(--terminal-accent)]">silicon triggers · live</p>
      <ReactivityGraph slug={slug} className="mt-4" />
    </div>
  );
}
