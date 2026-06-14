"use client";

import * as React from "react";
import { toast } from "sonner";

import { disablePush, enablePush, isPushEnabled, pushSupported } from "@/lib/push";
import { cn } from "@/lib/utils";

// Sound preferences. Persist to localStorage; sounds read the same
// `silicon-interface:sounds` key that lib/sounds consults, decoupled from
// prefers-reduced-motion.
const SOUNDS_KEY = "silicon-interface:sounds";

function readSounds(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(SOUNDS_KEY) !== "off";
  } catch {
    return true;
  }
}

function writeSounds(on: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOUNDS_KEY, on ? "on" : "off");
  } catch {
    /* private mode — preference can't persist */
  }
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cn(
          // Sharp corners, no shadow — a flat track + ink knob, on-brand.
          "relative inline-flex h-6 w-11 shrink-0 items-center border transition-colors",
          checked ? "bg-primary" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "block h-4 w-4 bg-background transition-transform",
            checked ? "translate-x-6" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}

export function PreferencesSection() {
  // Hydration-safe: localStorage isn't readable on the server, so we read after
  // mount. Defaults match the "on" baseline the helper falls back to.
  const [sounds, setSounds] = React.useState(true);
  const [pushAvailable, setPushAvailable] = React.useState(false);
  const [push, setPush] = React.useState(false);
  const [pushBusy, setPushBusy] = React.useState(false);

  React.useEffect(() => {
    // Read persisted prefs once after mount (localStorage is client-only).
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time hydration of client-only storage
    setSounds(readSounds());
    if (pushSupported()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time hydration of client-only state
      setPushAvailable(true);
      void isPushEnabled().then(setPush);
    }
  }, []);

  const togglePush = async (next: boolean) => {
    setPushBusy(true);
    try {
      if (next) {
        const result = await enablePush();
        if (result === "enabled") {
          setPush(true);
          toast.success("push notifications on");
        } else if (result === "denied") {
          toast.error("notifications are blocked for this site - allow them in the browser");
        } else if (result === "unconfigured") {
          toast.error("push isn't configured on this server yet");
        } else {
          toast.error("this browser doesn't support push");
        }
      } else {
        await disablePush();
        setPush(false);
        toast.success("push notifications off");
      }
    } catch {
      toast.error("couldn't update push subscription");
    } finally {
      setPushBusy(false);
    }
  };

  return (
    <section className="border-t pt-5">
      <h2 className="text-sm font-semibold">Preferences</h2>
      <div className="mt-1 divide-y">
        <Toggle
          label="Sound cues"
          description="Short tones for sent and received messages."
          checked={sounds}
          onChange={(next) => {
            setSounds(next);
            writeSounds(next);
          }}
        />
        {pushAvailable && (
          <div className={pushBusy ? "pointer-events-none opacity-60" : undefined}>
            <Toggle
              label="Push notifications"
              description="Messages and announcements reach this browser even when the tab is closed."
              checked={push}
              onChange={(next) => void togglePush(next)}
            />
          </div>
        )}
      </div>
    </section>
  );
}
