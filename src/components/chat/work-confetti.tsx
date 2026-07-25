"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Confetti } from "@phosphor-icons/react/dist/ssr";

import { cn } from "@/lib/utils";

const PARTICLES = Array.from({ length: 46 }, (_, index) => ({
  id: index,
  left: (index * 37 + 11) % 100,
  delay: (index % 11) * 0.045,
  duration: 1.25 + (index % 7) * 0.12,
  drift: ((index * 29) % 180) - 90,
  rotate: 240 + (index % 8) * 75,
  color: ["#1a1a1a", "#2d6b41", "#9a3f3f", "#c9b99a", "#5d5953"][index % 5],
  circle: index % 4 === 0,
}));

function ConfettiOverlay({ run }: { run: number }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      key={run}
      className="pointer-events-none fixed inset-0 z-[80] overflow-hidden motion-reduce:hidden"
      aria-hidden
    >
      <style>{
        "@keyframes work-confetti-fall{0%{transform:translate3d(0,-10vh,0) rotate(0deg);opacity:0}8%{opacity:1}100%{transform:translate3d(var(--work-confetti-drift),110vh,0) rotate(var(--work-confetti-rotate));opacity:.9}}"
      }</style>
      {PARTICLES.map((particle) => (
        <span
          key={particle.id}
          className={cn("absolute -top-4 h-2.5 w-1.5", particle.circle && "rounded-full")}
          style={
            {
              left: `${particle.left}%`,
              backgroundColor: particle.color,
              animation: `work-confetti-fall ${particle.duration}s cubic-bezier(.2,.65,.28,1) ${particle.delay}s both`,
              "--work-confetti-drift": `${particle.drift}px`,
              "--work-confetti-rotate": `${particle.rotate}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>,
    document.body,
  );
}

export interface WorkConfettiButtonProps {
  className?: string;
  label?: string;
}

/** A replayable, viewport-wide celebration that respects reduced motion. */
export function WorkConfettiButton({
  className,
  label = "Celebrate completion",
}: WorkConfettiButtonProps) {
  const [run, setRun] = React.useState(0);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    const timeout = window.setTimeout(() => setVisible(false), 2_450);
    return () => window.clearTimeout(timeout);
  }, [visible, run]);

  const celebrate = () => {
    setRun((value) => value + 1);
    setVisible(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={celebrate}
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center border-l text-foreground transition-colors hover:bg-accent",
          className,
        )}
        aria-label={label}
        title={label}
      >
        <Confetti className="h-4 w-4" weight="fill" aria-hidden />
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {visible ? "Celebrating task completion" : ""}
      </span>
      {visible ? <ConfettiOverlay run={run} /> : null}
    </>
  );
}
