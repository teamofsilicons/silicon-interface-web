"use client";

import * as React from "react";
import { ArrowUpRight, WarningCircle } from "@phosphor-icons/react/dist/ssr";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SiliconBrowserMark } from "@/components/chat/remote-browser-card";

/**
 * Open (or join) a silicon's cloud browser on demand — no need to wait for the
 * silicon to share a link. Opened from the browser icon in a silicon DM header.
 * Shows the launch progress, then an Open button that opens the Silicon Browser
 * viewer in a new tab. `siliconId` is the peer's public silicon_id.
 */
export function SiliconBrowserDialog({
  siliconId,
  siliconName,
  open,
  onOpenChange,
}: {
  siliconId: string;
  siliconName?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <SiliconBrowserMark className="h-6 w-6 shrink-0" />
            {siliconName ? `${siliconName}'s browser` : "Silicon Browser"}
          </DialogTitle>
        </DialogHeader>
        {/* Remounts on each open (Radix unmounts closed content) so the launch
            restarts cleanly each time. */}
        {open && <SiliconBrowserDialogBody siliconId={siliconId} />}
      </DialogContent>
    </Dialog>
  );
}

type Phase = "launching" | "ready" | "error";

const STEPS = [
  "Checking for a live session…",
  "Launching the browser…",
  "Almost ready…",
];

function SiliconBrowserDialogBody({ siliconId }: { siliconId: string }) {
  const [phase, setPhase] = React.useState<Phase>("launching");
  const [step, setStep] = React.useState(0);
  const [result, setResult] = React.useState<{ url: string; reused: boolean } | null>(null);
  const [error, setError] = React.useState("");

  const launch = React.useCallback(() => {
    setPhase("launching");
    setStep(0);
    setError("");
    setResult(null);

    let alive = true;
    // Walk the progress labels while the request is in flight — the backend
    // does check-then-maybe-create in one call, so this is honest staging.
    const timers = [
      window.setTimeout(() => alive && setStep(1), 700),
      window.setTimeout(() => alive && setStep(2), 2200),
    ];

    (async () => {
      try {
        const r = await api.openSiliconBrowser(siliconId);
        if (!alive) return;
        if (!r.viewer_url) throw new Error("No browser session was returned.");
        setResult({ url: r.viewer_url, reused: Boolean(r.reused || r.live) });
        setPhase("ready");
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Could not open the browser.");
        setPhase("error");
      } finally {
        timers.forEach((t) => window.clearTimeout(t));
      }
    })();

    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [siliconId]);

  React.useEffect(() => {
    let alive = true;
    let stopLaunch: (() => void) | undefined;
    queueMicrotask(() => {
      if (alive) stopLaunch = launch();
    });
    return () => {
      alive = false;
      stopLaunch?.();
    };
  }, [launch]);

  if (phase === "error") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <WarningCircle className="h-8 w-8 text-muted-foreground" />
        <p className="max-w-xs text-sm text-muted-foreground">{error}</p>
        <button
          type="button"
          onClick={launch}
          className="mt-1 h-9 border border-foreground bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  if (phase === "ready" && result) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <span
          aria-hidden
          className="h-2.5 w-2.5 rounded-full bg-foreground animate-pulse motion-reduce:animate-none"
        />
        <p className="text-sm font-medium">
          {result.reused ? "Joined the live session" : "Browser is ready"}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {result.reused
            ? "This silicon already had a browser open — you'll join exactly what it's doing."
            : "A fresh session started in this silicon's browser profile."}
        </p>
        <a
          href={result.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex items-center justify-center gap-1.5 bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          Open browser
          <ArrowUpRight className="h-4 w-4" weight="bold" />
        </a>
        <p className="text-[11px] text-muted-foreground">Opens in a new tab.</p>
      </div>
    );
  }

  // Launching.
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <span
        className="inline-block h-8 w-8 animate-spin border-2 border-muted-foreground border-t-transparent"
        style={{ borderRadius: "9999px" }}
        aria-hidden
      />
      <div className="flex flex-col items-center gap-2">
        {STEPS.map((label, i) => (
          <p
            key={i}
            className={cn(
              "text-sm transition-colors",
              i < step
                ? "text-muted-foreground/50 line-through"
                : i === step
                  ? "text-foreground"
                  : "text-muted-foreground/40",
            )}
          >
            {label}
          </p>
        ))}
      </div>
    </div>
  );
}
