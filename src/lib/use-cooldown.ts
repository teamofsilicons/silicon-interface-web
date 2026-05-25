"use client";

import * as React from "react";

/**
 * A simple countdown for resend buttons. `start(secs)` begins a cooldown;
 * `remaining` ticks down to 0; `active` is true while it's running.
 */
export function useCooldown() {
  const [until, setUntil] = React.useState(0);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (until <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [until]);

  const remaining = Math.max(0, Math.ceil((until - now) / 1000));
  return {
    remaining,
    active: remaining > 0,
    start: (secs: number) => {
      const t = Date.now();
      setNow(t);
      setUntil(t + secs * 1000);
    },
  };
}
