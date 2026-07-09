"use client";

import * as React from "react";

import { isLikelyStaleNextRouteError, reloadOnce } from "@/lib/recovery";

/**
 * Long-idle tabs can hold stale App Router/chunk state across deploys. When
 * the next soft navigation tries to load an old chunk, Next otherwise renders
 * its global "This page couldn't load" screen. Reload once and boot from the
 * latest document instead.
 */
export function RouteRecovery() {
  React.useEffect(() => {
    const recover = (reason: unknown) => {
      if (isLikelyStaleNextRouteError(reason)) reloadOnce("route-load");
    };
    const onError = (event: ErrorEvent) => recover(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => recover(event.reason);

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
