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
    if (!("serviceWorker" in navigator)) return;
    let alive = true;
    let reloading = false;
    const replacingExistingWorker = Boolean(navigator.serviceWorker.controller);
    const refreshWorker = () => registerPushWorker().then(async (registration) => {
      if (!alive || !registration) return;
      await registration.update().catch(() => undefined);
      // Older desktop prototypes could create a browser Push subscription.
      // Desktop notifications now come from the one live application path, so
      // retire that legacy subscription to prevent duplicate OS banners.
      if (isDesktopShell()) await disablePush();
    });
    const onControllerChange = () => {
      if (!replacingExistingWorker || reloading) return;
      reloading = true;
      // The worker also navigates controlled windows during activation. This
      // fallback runs only if that navigation did not already unload the page.
      window.setTimeout(() => window.location.reload(), 250);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshWorker();
    };
    void refreshWorker();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshWorker();
    }, 60_000);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    window.addEventListener("online", refreshWorker);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      window.clearInterval(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("online", refreshWorker);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
