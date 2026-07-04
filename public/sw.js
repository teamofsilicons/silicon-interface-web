// Silicon Interface service worker — Web Push delivery.
// Banners are suppressed when a tab is focused (the in-app UI already shows
// the message); `tag` dedupes against the in-tab Notification fallback.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// App-icon badge (total unread across rooms). Feature-detected — the Badging
// API is absent on most desktop Linux browsers and older mobile WebKit.
async function applyAppBadge(badge) {
  if (typeof badge !== "number" || !("setAppBadge" in navigator)) return;
  try {
    if (badge > 0) await navigator.setAppBadge(badge);
    else await navigator.clearAppBadge();
  } catch {
    /* badging unavailable — non-fatal */
  }
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Silicon Interface", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    (async () => {
      // Cross-device read sync — a silent push sent to the reader's own
      // devices when they read a room anywhere. No banner: close any displayed
      // notification for that room (tag = room_id) and reconcile the app badge.
      if (data.kind === "read_sync") {
        if (data.tag) {
          const shown = await self.registration.getNotifications({ tag: data.tag });
          for (const n of shown) n.close();
        }
        await applyAppBadge(data.badge);
        return;
      }
      // The badge rides on every push (total unread) — apply it even when a
      // focused tab suppresses the banner, so the OS badge never goes stale.
      await applyAppBadge(data.badge);
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (tabs.some((tab) => tab.focused)) return;
      await self.registration.showNotification(data.title || "Silicon Interface", {
        body: data.body || "",
        tag: data.tag || undefined,
        icon: "/logo.png",
        badge: "/logo.png",
        data: { url: data.url || "/" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const tab of tabs) {
        if ("focus" in tab) {
          await tab.focus();
          if ("navigate" in tab) await tab.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
