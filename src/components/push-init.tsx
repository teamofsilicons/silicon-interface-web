"use client";

import * as React from "react";

import { disablePush, registerPushWorker } from "@/lib/push";
import { isDesktopShell } from "@/lib/desktop-bridge";

/**
 * Registers the push service worker on load so an existing subscription keeps
 * delivering and sw.js updates propagate. Never prompts — permission is asked
 * only when the user flips the settings toggle.
 */
export function PushInit() {
  React.useEffect(() => {
    void registerPushWorker().then(() => {
      // Older desktop prototypes could create a browser Push subscription.
      // Desktop notifications now come from the one live application path, so
      // retire that legacy subscription to prevent duplicate OS banners.
      if (isDesktopShell()) return disablePush();
    });
  }, []);
  return null;
}
