"use client";

const VERSION = 1;
const MAX_NOTIFICATIONS = 80;
const PREFIX = "silicon-interface:notifications";
export const NOTIFICATION_EVENT = "silicon-interface:notifications-changed";

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
}

function key(ownerId: string): string {
  return `${PREFIX}:${encodeURIComponent(ownerId)}`;
}

function notify(ownerId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NOTIFICATION_EVENT, { detail: { ownerId } }));
}

export function loadNotifications(ownerId: string): InterfaceNotification[] {
  if (typeof window === "undefined" || !ownerId) return [];
  const raw = window.localStorage.getItem(key(ownerId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredNotifications>;
    if (parsed.version !== VERSION || parsed.ownerId !== ownerId || !Array.isArray(parsed.items)) {
      return [];
    }
    return parsed.items;
  } catch {
    return [];
  }
}

function saveNotifications(ownerId: string, items: InterfaceNotification[]) {
  if (typeof window === "undefined" || !ownerId) return;
  const payload: StoredNotifications = {
    version: VERSION,
    ownerId,
    items: items.slice(0, MAX_NOTIFICATIONS),
  };
  try {
    window.localStorage.setItem(key(ownerId), JSON.stringify(payload));
  } catch {
    try {
      window.localStorage.setItem(
        key(ownerId),
        JSON.stringify({ ...payload, items: payload.items.slice(0, 30) }),
      );
    } catch {
      window.localStorage.removeItem(key(ownerId));
    }
  }
  notify(ownerId);
}

export function addNotification(ownerId: string, item: Omit<InterfaceNotification, "ownerId" | "read">) {
  if (!ownerId || typeof window === "undefined") return;
  const current = loadNotifications(ownerId);
  if (current.some((n) => n.eventId === item.eventId)) return;
  saveNotifications(ownerId, [{ ...item, ownerId, read: false }, ...current]);
}

export function markNotificationRead(ownerId: string, id: string) {
  const current = loadNotifications(ownerId);
  saveNotifications(
    ownerId,
    current.map((item) => (item.id === id ? { ...item, read: true } : item)),
  );
}

export function markRoomNotificationsRead(ownerId: string, roomId: string) {
  const current = loadNotifications(ownerId);
  saveNotifications(
    ownerId,
    current.map((item) => (item.roomId === roomId ? { ...item, read: true } : item)),
  );
}

export function markAllNotificationsRead(ownerId: string) {
  const current = loadNotifications(ownerId);
  saveNotifications(
    ownerId,
    current.map((item) => ({ ...item, read: true })),
  );
}

export function clearNotifications(ownerId: string) {
  saveNotifications(ownerId, []);
}

export function browserNotificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

export async function requestBrowserNotifications(): Promise<NotificationPermission | "unsupported"> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.requestPermission();
}

export function showBrowserNotification(
  title: string,
  options: NotificationOptions & { roomId?: string } = {},
) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (window.Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;
  try {
    const notification = new window.Notification(title, {
      icon: "/icon.png",
      badge: "/icon.png",
      ...options,
    });
    notification.onclick = () => {
      window.focus();
      if (options.roomId) window.location.href = `/chat?room=${encodeURIComponent(options.roomId)}`;
      notification.close();
    };
  } catch {
    /* Some browsers still reject Notification construction despite permission. */
  }
}
