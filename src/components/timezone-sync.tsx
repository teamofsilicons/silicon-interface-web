"use client";

import * as React from "react";

import { api } from "@/lib/api";
import { authStore } from "@/lib/auth";
import { guessTimezone } from "@/lib/timezones";

/**
 * Persist the carbon's timezone from the browser (Intl, *not* IP geolocation)
 * when the server has none yet. This is what lets silicons see message
 * timestamps in the human's local time. We only fill an empty value so a
 * timezone the user picked manually in their profile is never clobbered.
 */
export function TimezoneSync() {
  React.useEffect(() => {
    const carbon = authStore.getCarbon();
    // Silicon-key-only sessions have no carbon; skip. Already set → leave it.
    if (!carbon || carbon.timezone) return;
    const tz = guessTimezone();
    if (!tz) return;
    let alive = true;
    api
      .patchMe({ timezone: tz })
      .then((updated) => {
        if (alive) authStore.setCarbon(updated);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return null;
}
