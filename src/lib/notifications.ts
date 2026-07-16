"use client";

import * as React from "react";

import { desktopBridge } from "./desktop-bridge";

const VERSION = 2;
const MAX_NOTIFICATIONS = 80;
const PREFIX = "silicon-interface:notifications";
export const NOTIFICATION_EVENT = "silicon-interface:notifications-changed";
// Soft-navigation request raised when a browser/OS notification is clicked.
// The chat page subscribes and opens the room via the History API — see
// showBrowserNotification. This avoids the cold window.location reload that
// used to tear down the live socket.
export const NOTIFICATION_NAVIGATE_EVENT = "silicon-interface:notifications-navigate";

export interface InterfaceNotification {
  id: string;
  ownerId: string;
  roomId: string;
  eventId: string;
  title: string;
  body: string;
  at: string;
  read: boolean;
  avatarUrl?: string | null;
  avatarSeed?: string;
}

interface StoredNotifications {
  version: typeof VERSION;
  ownerId: string;
  items: InterfaceNotification[];
  // Unread count is tracked independently of `items` so trimming the kept
  // window (cap at 80, shrink to 30 under quota) never silently undercounts
  // unread. `unreadExtra` holds unread notifications that fell out of the
  // kept window; the visible count is `unreadExtra + (unread items kept)`.
  unreadExtra: number;
}

function key(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

function notify(ownerId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NOTIFICATION_EVENT, { detail: { ownerId } }));
}

function read(ownerId: string): StoredNotifications {
  const empty: StoredNotifications = { version: VERSION, ownerId, items: [], unreadExtra: 0 };
  if (typeof window === "undefined" || !ownerId) return empty;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key(ownerId));
  } catch {
    return empty;
  }
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredNotifications>;
    if (parsed.version !== VERSION || parsed.ownerId !== ownerId || !Array.isArray(parsed.items)) {
      return empty;
    }
    return {
      version: VERSION,
      ownerId,
      items: parsed.items,
      unreadExtra: typeof parsed.unreadExtra === "number" && parsed.unreadExtra > 0 ? parsed.unreadExtra : 0,
    };
  } catch {
    return empty;
  }
}

export function loadNotifications(ownerId: string): InterfaceNotification[] {
  return read(ownerId).items;
}

/**
 * Live unread count, decoupled from the kept-items window. Equals the unread
 * items still in the window plus any unread that were trimmed away — so a user
 * with 200 truly-unread notifications sees "200", not a value capped at the
 * window size.
 */
export function loadUnreadCount(ownerId: string): number {
  const store = read(ownerId);
  const keptUnread = store.items.reduce((n, item) => (item.read ? n : n + 1), 0);
  return keptUnread + store.unreadExtra;
}

/** How many notifications exist beyond the kept window — drives a "showing latest N" affordance. */
export function trimmedCount(ownerId: string): number {
  return read(ownerId).unreadExtra;
}

function persist(ownerId: string, items: InterfaceNotification[], unreadExtra: number) {
  if (typeof window === "undefined" || !ownerId) return;
  const write = (keep: number, extra: number) => {
    // Items that get trimmed and are still unread must roll into unreadExtra so
    // the visible unread count stays accurate even as the window shrinks.
    const trimmedUnread = items.slice(keep).reduce((n, item) => (item.read ? n : n + 1), 0);
    const payload: StoredNotifications = {
      version: VERSION,
      ownerId,
      items: items.slice(0, keep),
      unreadExtra: extra + trimmedUnread,
    };
    window.localStorage.setItem(key(ownerId), JSON.stringify(payload));
  };
  try {
    write(MAX_NOTIFICATIONS, unreadExtra);
  } catch {
    try {
      // Quota pressure — keep a smaller window but preserve the unread count by
      // folding the additionally-dropped items into unreadExtra (handled in write).
      write(30, unreadExtra);
    } catch {
      try {
        window.localStorage.removeItem(key(ownerId));
      } catch {
        /* storage unavailable — notification cache is best-effort */
      }
    }
  }
  notify(ownerId);
}

function saveNotifications(ownerId: string, items: InterfaceNotification[]) {
  // Preserve the existing trimmed-unread tally across non-trimming mutations.
  persist(ownerId, items, read(ownerId).unreadExtra);
}

export function addNotification(ownerId: string, item: Omit<InterfaceNotification, "ownerId" | "read">) {
  if (!ownerId || typeof window === "undefined") return;
  const current = loadNotifications(ownerId);
  if (current.some((n) => n.eventId === item.eventId)) return;
  saveNotifications(ownerId, [{ ...item, ownerId, read: false }, ...current]);
}

export function markNotificationRead(ownerId: string, id: string) {
  const store = read(ownerId);
  // A kept item is being read. If it was unread we don't touch unreadExtra,
  // because that counts items already gone from the window.
  persist(
    ownerId,
    store.items.map((item) => (item.id === id ? { ...item, read: true } : item)),
    store.unreadExtra,
  );
}

export function markRoomNotificationsRead(ownerId: string, roomId: string) {
  const store = read(ownerId);
  persist(
    ownerId,
    store.items.map((item) => (item.roomId === roomId ? { ...item, read: true } : item)),
    store.unreadExtra,
  );
}

export function markAllNotificationsRead(ownerId: string) {
  const store = read(ownerId);
  // "Mark all" also clears the trimmed-unread tally — the user has acknowledged
  // everything, including notifications no longer in the window.
  persist(
    ownerId,
    store.items.map((item) => ({ ...item, read: true })),
    0,
  );
}

export function clearNotifications(ownerId: string) {
  persist(ownerId, [], 0);
}

/** Remove a retracted event without marking unrelated room notifications read. */
export function removeNotificationByEvent(ownerId: string, eventId: string) {
  if (!ownerId || !eventId) return;
  const store = read(ownerId);
  const items = store.items.filter((item) => item.eventId !== eventId);
  if (items.length !== store.items.length) persist(ownerId, items, store.unreadExtra);
}

// ---- Desktop-wrapper awareness ---------------------------------------------
// The native desktop apps (WKWebView / WebView2 shells) inject a bridge that
// marks itself via `__siliconBridge`, and — on hosts that support it — mirrors
// the real window state into `__siliconWindowState`. Inside a webview the
// document-level signals are unreliable: WebView2 reports visibilityState
// "visible" even when the window is minimized, and document.hasFocus() stays
// false until the user clicks into the page. The wrapper knows the truth.
interface WrapperWindowState {
  focused: boolean;
  visible: boolean;
}

let desktopWindowState: WrapperWindowState | undefined;

declare global {
  interface Window {
    __siliconBridge?: boolean;
    __siliconWindowState?: WrapperWindowState;
    __siliconSetBadge?: (count: number) => void;
  }
}

/** Raised (by the wrapper bridge) whenever the native window state changes. */
export const WINDOW_STATE_EVENT = "silicon-interface:window-state";

/**
 * True when the user can be assumed to be looking at the app: in a browser, a
 * visible tab; in the desktop wrapper, a visible AND focused window. Presence
 * gates the notification split (present → in-app toast, absent → OS
 * notification) and auto-read.
 */
export function userPresent(): boolean {
  if (typeof document === "undefined") return true;
  const bridge = desktopBridge();
  // Until the native state arrives, prefer suppressing an OS notification over
  // risking both an in-app toast and an OS banner for the same message.
  if (bridge && !desktopWindowState) return true;
  const ws = desktopWindowState
    ?? (typeof window !== "undefined" ? window.__siliconWindowState : undefined);
  if (ws) return ws.visible && ws.focused;
  return document.visibilityState === "visible";
}

/** Subscribe to presence flips (tab visibility or wrapper window state). */
export function onPresenceChange(cb: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const bridge = desktopBridge();
  const unsubscribe = bridge?.window.onStateChanged((state) => {
    desktopWindowState = state;
    cb();
  });
  if (bridge) {
    void bridge.window.getState().then((state) => {
      desktopWindowState = state;
      cb();
    }).catch(() => undefined);
  }
  window.addEventListener(WINDOW_STATE_EVENT, cb);
  document.addEventListener("visibilitychange", cb);
  return () => {
    unsubscribe?.();
    window.removeEventListener(WINDOW_STATE_EVENT, cb);
    document.removeEventListener("visibilitychange", cb);
  };
}

/** React hook over userPresent(). */
export function usePresence(): boolean {
  return React.useSyncExternalStore(onPresenceChange, userPresent, () => true);
}

/**
 * Report the total unread count to the desktop wrapper (drives the Dock /
 * taskbar badge). A no-op in plain browsers and in wrappers that don't define
 * the hook.
 */
export function reportUnreadBadge(count: number) {
  if (typeof window === "undefined") return;
  try {
    const bridge = desktopBridge();
    if (bridge) {
      bridge.window.setBadgeCount(count);
      return;
    }
    window.__siliconSetBadge?.(count);
  } catch {
    /* wrapper hook misbehaved — never let it break the app */
  }
}

export function browserNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

export async function requestBrowserNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.requestPermission();
}

// We prompt for notification access the first time the user sends a message
// (in-app priming → the real OS prompt). This flag makes that a one-time ask.
const NOTIF_ASKED_KEY = "silicon-interface:notif-asked";

/** True only when notifications are supported, not yet granted/denied, and we
 *  haven't already prompted the user. */
export function shouldPromptNotifications(): boolean {
  if (browserNotificationPermission() !== "default") return false;
  try {
    return window.localStorage.getItem(NOTIF_ASKED_KEY) !== "1";
  } catch {
    return false;
  }
}

export function markNotificationsAsked(): void {
  try {
    window.localStorage.setItem(NOTIF_ASKED_KEY, "1");
  } catch {
    /* private mode — we just may ask again next session */
  }
}

export function showBrowserNotification(
  title: string,
  options: NotificationOptions & { roomId?: string } = {},
) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (window.Notification.permission !== "granted") return;
  // Only raise an OS notification when the user isn't looking. In a browser
  // that means a hidden tab (a visible-but-unfocused tab — second monitor —
  // already gets the in-app toast; firing the OS notification too would be a
  // double-notify). In the desktop wrapper, presence means the native window
  // is visible AND focused — the wrapper feeds that state in, since webview
  // visibilityState/hasFocus are unreliable there.
  if (userPresent()) return;
  try {
    const notification = new window.Notification(title, {
      icon: "/icon.png",
      badge: "/icon.png",
      ...options,
    });
    const eventId = typeof options.tag === "string" ? options.tag : "";
    if (eventId) activeBrowserNotifications.set(eventId, notification);
    notification.onclose = () => {
      if (eventId && activeBrowserNotifications.get(eventId) === notification) {
        activeBrowserNotifications.delete(eventId);
      }
    };
    notification.onclick = () => {
      desktopBridge()?.window.show();
      window.focus();
      // Soft client-side navigation: ask a subscriber (the chat page) to open
      // the room instead of a hard window.location.href, which would
      // cold-reload the SPA and drop the live socket.
      if (options.roomId) {
        window.dispatchEvent(new CustomEvent(NOTIFICATION_NAVIGATE_EVENT, {
          detail: {
            roomId: options.roomId,
          },
        }));
      }
      notification.close();
    };
  } catch {
    /* Some browsers still reject Notification construction despite permission. */
  }
}

const activeBrowserNotifications = new Map<string, Notification>();

/** Close an already displayed foreground Notification for one exact event. */
export function closeBrowserNotification(eventId: string) {
  const notification = activeBrowserNotifications.get(eventId);
  if (!notification) return;
  activeBrowserNotifications.delete(eventId);
  try { notification.close(); } catch { /* browser disposed it already */ }
}
