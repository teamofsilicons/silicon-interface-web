"use client";

import * as React from "react";

/** A `Date` that re-renders every `intervalMs` (for live clocks). */
export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
