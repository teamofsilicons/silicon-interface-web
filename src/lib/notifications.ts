"use client";

const VERSION = 2;
const MAX_NOTIFICATIONS = 80;
const PREFIX = "silicon-interface:notifications";
export const NOTIFICATION_EVENT = "silicon-interface:notifications-changed";
// Soft-navigation request raised when a browser/OS notification is clicked.
// The NotificationCenter (which owns a Next router) subscribes and does a
// client-side push — see showBrowserNotification. This avoids the cold
// window.location reload that used to tear down the live socket.
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
  const raw = window.localStorage.getItem(key(ownerId));
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
      window.localStorage.removeItem(key(ownerId));
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
  // Only raise an OS notification when the document is hidden. A visible tab —
  // even one that's unfocused (a second monitor) — already gets the in-app
  // toast; firing the OS notification too is a double-notify. Gating purely on
  // visibilityState (not hasFocus) suppresses that duplicate.
  if (document.visibilityState === "visible") return;
  try {
    const notification = new window.Notification(title, {
      icon: "/icon.png",
      badge: "/icon.png",
      ...options,
    });
    notification.onclick = () => {
      window.focus();
      // Soft client-side navigation: ask a subscriber (NotificationCenter) to
      // router.push instead of a hard window.location.href, which would
      // cold-reload the SPA and drop the live socket.
      if (options.roomId) {
        window.dispatchEvent(
          new CustomEvent(NOTIFICATION_NAVIGATE_EVENT, { detail: { roomId: options.roomId } }),
        );
      }
      notification.close();
    };
  } catch {
    /* Some browsers still reject Notification construction despite permission. */
  }
}
