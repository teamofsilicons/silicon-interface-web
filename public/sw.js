// Silicon Interface service worker — Web Push delivery and an offline shell.
// Banners are suppressed when a tab is focused (the in-app UI already shows
// the message); `tag` dedupes against the in-tab Notification fallback.

self.SILICON_SHELL_CACHE = "silicon-interface-shell-v4";
const SILICON_REPLACING_WORKER = Boolean(self.registration.active);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      const olderShells = names.filter((name) =>
        name.startsWith("silicon-interface-shell-") &&
        name !== self.SILICON_SHELL_CACHE);
      await Promise.all(
        olderShells.map((name) => caches.delete(name)),
      );
      await self.clients.claim();
      // Schema-changing releases cannot leave an already-open tab executing
      // the older bundle: it would request an older IndexedDB version and stop
      // room sync with VersionError. Reload each same-origin window exactly
      // once whenever this worker replaces an existing controller. Cache-name
      // detection remains a fallback for installations created by very old
      // workers that did not expose a reliable active-controller marker.
      if (SILICON_REPLACING_WORKER || olderShells.length > 0) {
        const windows = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        await Promise.all(
          windows.map(async (client) => {
            try {
              await client.navigate(client.url);
            } catch {
              // A closing tab is already leaving this worker's ownership.
            }
          }),
        );
      }
    })(),
  );
});

function offlineNavigationKey(url) {
  if (url.pathname === "/" || url.pathname === "/chat" || url.pathname === "/settings") {
    return new Request(url.origin + url.pathname, { method: "GET" });
  }
  return null;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(self.SILICON_SHELL_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          await cache.put(request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  if (request.mode !== "navigate") return;
  const key = offlineNavigationKey(url);
  if (!key) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(self.SILICON_SHELL_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          await cache.put(key, response.clone());
        }
        return response;
      } catch {
        return (await cache.match(key)) ||
          (await cache.match(new Request(url.origin + "/chat", { method: "GET" }))) ||
          Response.error();
      }
    })(),
  );
});

async function openNotificationState() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("silicon-interface-notification-state", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function setActiveNotificationOwner(ownerId) {
  if (!self.indexedDB) return;
  const db = await openNotificationState();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction("state", "readwrite");
    transaction.objectStore("state").put({ key: "active-owner", value: String(ownerId || "") });
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
}

async function activeNotificationOwner() {
  if (!self.indexedDB) return "";
  try {
    const db = await openNotificationState();
    const value = await new Promise((resolve, reject) => {
      const request = db.transaction("state", "readonly").objectStore("state").get("active-owner");
      request.onsuccess = () => resolve(request.result?.value || "");
      request.onerror = () => reject(request.error);
    });
    db.close();
    return value;
  } catch { return ""; }
}

self.addEventListener("message", (event) => {
  if (event.data?.type !== "silicon-active-notification-owner") return;
  event.waitUntil(setActiveNotificationOwner(event.data.ownerId));
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

function canonicalBadge(data) {
  const ownerId = String(data.owner_id || data.ownerId || "").trim();
  const revision = Number(data.badge_revision ?? data.badgeRevision);
  const badge = Number(data.badge);
  if (!ownerId || ownerId.length > 26 || !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(badge) || badge < 0) return null;
  return { ownerId, revision, badge };
}

async function commitBadge(data) {
  const incoming = canonicalBadge(data);
  if (!incoming || !self.indexedDB) return { outcome: "conflict", value: incoming };
  try {
    const db = await openNotificationState();
    const outcome = await new Promise((resolve, reject) => {
      const transaction = db.transaction("state", "readwrite");
      const store = transaction.objectStore("state");
      const key = `badge:${incoming.ownerId}`;
      const request = store.get(key);
      let decided = "conflict";
      request.onsuccess = () => {
        const current = request.result?.value;
        if (current && incoming.revision < current.revision) decided = "stale";
        else if (current && incoming.revision === current.revision) {
          decided = current.badge === incoming.badge ? "stale" : "conflict";
        } else {
          store.put({ key, value: incoming });
          decided = "applied";
        }
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(decided);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return { outcome, value: incoming };
  } catch {
    return { outcome: "conflict", value: incoming };
  }
}

async function acknowledgeDisplay(data, outcome, reason = "") {
  if (!data.display_ack_url || !data.delivery_id || !data.display_ack_token) return;
  try {
    const body = new URLSearchParams({
      delivery_id: data.delivery_id,
      token: data.display_ack_token,
      outcome,
      reason,
    });
    const headers = {};
    if (typeof data.traceparent === "string" && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(data.traceparent)) {
      headers.traceparent = data.traceparent;
    }
    await fetch(data.display_ack_url, { method: "POST", body, headers });
  } catch {
    // Telemetry is best-effort and must never interfere with notification UX.
  }
}

async function persistAbuseProof(token, answer) {
  if (!token || !answer || !self.indexedDB) return;
  try {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("silicon-interface-abuse-proofs", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("proofs", { keyPath: "token" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("proofs", "readwrite");
      transaction.objectStore("proofs").put({ token, answer, at: Date.now() });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  } catch {
    // The in-page message path remains available; proof storage is fallback.
  }
}

function canonicalReadReconciliation(data) {
  const ownerId = String(data.owner_id || "").trim();
  const roomId = String(data.room_id || data.tag || "").trim();
  const revision = Number(data.reconciliation_revision);
  const badge = Number(data.badge);
  const badgeRevision = Number(data.badge_revision);
  const vector = data.read_stream_vector;
  if (!ownerId || ownerId.length > 26 || !roomId || roomId.length > 26 ||
      !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(badgeRevision) || badgeRevision < 1 ||
      !Number.isSafeInteger(badge) || badge < 0 || !vector || typeof vector !== "object" ||
      Array.isArray(vector) || !Number.isSafeInteger(vector.floor) || vector.floor < 0 ||
      !vector.writers || typeof vector.writers !== "object" || Array.isArray(vector.writers)) {
    return null;
  }
  const entries = Object.entries(vector.writers);
  if (entries.length > 64 || entries.some(([writer, position]) =>
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(writer) ||
    !Number.isSafeInteger(position) || position <= vector.floor)) return null;
  return {
    ownerId, roomId, revision, badge, badgeRevision,
    vector: { floor: vector.floor, writers: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) },
  };
}

function reconciliationCovers(value, notification) {
  const roomId = notification.data?.roomId;
  const writer = notification.data?.streamWriter;
  const position = Number(notification.data?.streamPosition);
  if (notification.data?.ownerId !== value.ownerId || roomId !== value.roomId ||
      typeof writer !== "string" || !writer ||
      !Number.isSafeInteger(position) || position < 1) return false;
  return position <= (value.vector.writers[writer] ?? value.vector.floor);
}

async function commitReadReconciliation(data) {
  const incoming = canonicalReadReconciliation(data);
  if (!incoming || !self.indexedDB) return { outcome: "conflict", value: incoming };
  try {
    const db = await openNotificationState();
    const outcome = await new Promise((resolve, reject) => {
      const transaction = db.transaction("state", "readwrite");
      const store = transaction.objectStore("state");
      const key = `read-reconciliation:${incoming.ownerId}`;
      const request = store.get(key);
      let decided = "conflict";
      request.onsuccess = () => {
        const current = request.result?.value;
        if (current && incoming.revision < current.revision) decided = "stale";
        else if (current && incoming.revision === current.revision) {
          const sameRead = current.ownerId === incoming.ownerId &&
            current.roomId === incoming.roomId &&
            JSON.stringify(current.vector) === JSON.stringify(incoming.vector);
          decided = sameRead ? "stale" : "conflict";
        } else {
          store.put({ key, value: incoming });
          decided = "applied";
        }
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(decided);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return { outcome, value: incoming };
  } catch {
    return { outcome: "conflict", value: incoming };
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
      // notifications for that room and reconcile the app badge.
      if (data.kind === "read_sync") {
        const committed = await commitReadReconciliation(data);
        if (committed.outcome === "conflict") return;
        const badgeCommitted = await commitBadge({
          ownerId: committed.value.ownerId,
          badge: committed.value.badge,
          badgeRevision: committed.value.badgeRevision,
        });
        if (committed.outcome === "applied" && committed.value.roomId) {
          const shown = await self.registration.getNotifications();
          for (const n of shown) {
            if (reconciliationCovers(committed.value, n)) n.close();
          }
          if (await activeNotificationOwner() === committed.value.ownerId) {
            const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
            for (const tab of tabs) {
              tab.postMessage({ type: "silicon-read-reconciliation", ...committed.value });
            }
          }
        }
        if (badgeCommitted.outcome === "applied" &&
            await activeNotificationOwner() === committed.value.ownerId) {
          await applyAppBadge(committed.value.badge);
        }
        await acknowledgeDisplay(data, "reconciled");
        return;
      }
      if (data.kind === "redaction_sync") {
        const ownerId = typeof data.owner_id === "string" ? data.owner_id : "";
        const roomId = typeof data.room_id === "string" ? data.room_id : "";
        const eventId = typeof data.redacted_event_id === "string"
          ? data.redacted_event_id : "";
        if (!ownerId || !roomId || !eventId || await activeNotificationOwner() !== ownerId) {
          await acknowledgeDisplay(data, "suppressed", "account_changed");
          return;
        }
        const shown = await self.registration.getNotifications();
        for (const notification of shown) {
          if (notification.data?.ownerId === ownerId &&
              notification.data?.notificationId === eventId) {
            notification.close();
          }
        }
        const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const tab of tabs) {
          tab.postMessage({
            type: "silicon-redaction-sync",
            ownerId,
            roomId,
            eventId,
          });
        }
        await acknowledgeDisplay(data, "reconciled");
        return;
      }
      if (data.owner_id && await activeNotificationOwner() !== data.owner_id) {
        await acknowledgeDisplay(data, "suppressed", "account_changed");
        return;
      }
      if (data.kind === "abuse_challenge") {
        const proof = {
          type: "silicon-abuse-challenge-proof",
          token: data.challenge_token || "",
          answer: data.challenge_answer || "",
        };
        await persistAbuseProof(proof.token, proof.answer);
        const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const tab of tabs) tab.postMessage(proof);
        if (tabs.length > 0) {
          await acknowledgeDisplay(data, "suppressed", "app_running");
          return;
        }
        await self.registration.showNotification(data.title || "Verify this device", {
          body: data.body || "Open Silicon to continue sending.",
          tag: data.tag || "silicon-abuse-challenge",
          icon: "/logo.png",
          badge: "/logo.png",
          data: {
            url: data.url || "/chat",
            challengeToken: proof.token,
            challengeAnswer: proof.answer,
          },
        });
        await acknowledgeDisplay(data, "displayed");
        return;
      }
      // The badge rides on every push (total unread) — apply it even when a
      // focused tab suppresses the banner, so the OS badge never goes stale.
      const badgeCommitted = await commitBadge(data);
      if (badgeCommitted.outcome === "applied") await applyAppBadge(badgeCommitted.value.badge);
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (tabs.some((tab) => tab.focused)) {
        await acknowledgeDisplay(data, "suppressed", "foreground");
        return;
      }
      await self.registration.showNotification(data.title || "Silicon Interface", {
        body: data.body || "",
        silent: data.sound === false,
        tag: data.tag || undefined,
        icon: "/logo.png",
        badge: "/logo.png",
        data: {
          url: data.url || "/",
          roomId: data.room_id || "",
          notificationId: data.notification_id || data.tag || "",
          ownerId: data.owner_id || "",
          streamWriter: data.stream_writer || "",
          streamPosition: data.stream_position,
        },
      });
      await acknowledgeDisplay(data, "displayed");
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    (async () => {
      const proof = event.notification.data?.challengeToken
        ? {
            type: "silicon-abuse-challenge-proof",
            token: event.notification.data.challengeToken,
            answer: event.notification.data.challengeAnswer || "",
          }
        : null;
      const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const tab of tabs) {
        if ("focus" in tab) {
          await tab.focus();
          if ("navigate" in tab) await tab.navigate(url);
          if (proof) tab.postMessage(proof);
          return;
        }
      }
      const opened = await self.clients.openWindow(url);
      if (opened && proof) opened.postMessage(proof);
    })(),
  );
});
