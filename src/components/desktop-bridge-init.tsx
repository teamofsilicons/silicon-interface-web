"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/lib/auth";
import { desktopBridge, type DesktopDeepLink } from "@/lib/desktop-bridge";
import { prepareDraftsForDesktopLifecycle } from "@/lib/drafts";

const PENDING_CHAT_LINK = "silicon-interface:desktop-pending-chat-link";
const SAFE_CHAT_PATH = /^\/chat\?room=[0-9A-HJKMNP-TV-Z]{26}(?:&message=[A-Za-z0-9%:_-]{1,768})?$/i;
const SAFE_JOIN_PATH = /^\/join\/[A-Za-z0-9_-]{8,256}$/;

function validLink(link: DesktopDeepLink): boolean {
  return (
    (link.kind === "chat" && SAFE_CHAT_PATH.test(link.path)) ||
    (link.kind === "join" && SAFE_JOIN_PATH.test(link.path))
  );
}

function readPending(): string | null {
  try {
    const path = window.sessionStorage.getItem(PENDING_CHAT_LINK);
    return path && SAFE_CHAT_PATH.test(path) ? path : null;
  } catch {
    return null;
  }
}

function writePending(path: string | null): void {
  try {
    if (path) window.sessionStorage.setItem(PENDING_CHAT_LINK, path);
    else window.sessionStorage.removeItem(PENDING_CHAT_LINK);
  } catch {
    // Session storage can be unavailable under a restrictive browser policy.
  }
}

export function DesktopBridgeInit() {
  const router = useRouter();
  const { isAuthed } = useAuth();

  React.useEffect(() => {
    const bridge = desktopBridge();
    if (!bridge) return;

    const unsubscribe = bridge.links.onDeepLink((link) => {
      if (!validLink(link)) return;
      if (link.kind === "chat") writePending(link.path);
      router.push(link.path);
    });
    const unsubscribeQuit = bridge.lifecycle.onBeforeQuit(() => {
      void prepareDraftsForDesktopLifecycle()
        .then((ready) => bridge.lifecycle.flushComplete(ready))
        .catch(() => bridge.lifecycle.flushComplete(false));
    });
    const unsubscribeResume = bridge.lifecycle.onResume(() => {
      window.dispatchEvent(new Event("silicon-interface:desktop-resume"));
      if (navigator.onLine) window.dispatchEvent(new Event("online"));
    });
    const unsubscribeSuspend = bridge.lifecycle.onSuspend(() => {
      void prepareDraftsForDesktopLifecycle();
    });
    bridge.lifecycle.rendererReady();
    return () => {
      unsubscribe();
      unsubscribeQuit();
      unsubscribeResume();
      unsubscribeSuspend();
    };
  }, [router]);

  React.useEffect(() => {
    if (!isAuthed) return;
    const pending = readPending();
    if (!pending) return;
    writePending(null);
    router.replace(pending);
  }, [isAuthed, router]);

  return null;
}
