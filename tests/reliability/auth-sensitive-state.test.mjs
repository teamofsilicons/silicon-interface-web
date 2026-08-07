import test from "node:test";
import assert from "node:assert/strict";

import {
  authStore,
  handleAuthStorageChange,
  purgeStoredCredentials,
} from "../../src/lib/auth.ts";

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
    values,
  };
}

function resetAuthMemory() {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true });
  authStore.clear("revoked");
  if (previousFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previousFetch;
}

test("only user logout persists a reload-proof logout decision", () => {
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const localStorage = storage();
  globalThis.window = {
    localStorage,
    dispatchEvent() {},
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
  };
  globalThis.fetch = async () => ({ ok: true });

  authStore.setTokens("access");
  authStore.clear();
  assert.equal(authStore.wasExplicitlyLoggedOut(), true);
  assert.equal(localStorage.getItem("silicon-interface:explicit-logout"), "1");

  authStore.setTokens("stale-refresh");
  assert.equal(authStore.getAccess(), null);
  assert.equal(authStore.wasExplicitlyLoggedOut(), true);

  authStore.setTokens("new-access", null, undefined, "interactive");
  assert.equal(authStore.wasExplicitlyLoggedOut(), false);
  assert.equal(localStorage.getItem("silicon-interface:explicit-logout"), null);

  authStore.clear("revoked");
  assert.equal(authStore.wasExplicitlyLoggedOut(), false);
  assert.equal(localStorage.getItem("silicon-interface:explicit-logout"), null);

  authStore.setTokens("expired-session", null, {
    carbon_id: "expired-owner",
    username: "expired-owner",
    name: "Expired Owner",
    tagline: "",
    timezone: "UTC",
    is_staff: false,
    is_lord: false,
  }, "interactive");
  authStore.clear("expired");
  assert.equal(authStore.getCarbon(), null);
  assert.equal(authStore.wasExplicitlyLoggedOut(), false);
  assert.equal(localStorage.getItem("silicon-interface:explicit-logout"), null);

  authStore.setTokens("second-tab-access");
  localStorage.setItem("silicon-interface:explicit-logout", "1");
  handleAuthStorageChange("silicon-interface:explicit-logout", "1");
  assert.equal(authStore.getAccess(), null);
  assert.equal(authStore.wasExplicitlyLoggedOut(), true);
  authStore.setTokens("cleanup", null, undefined, "interactive");
  authStore.clear("revoked");

  if (previousFetch === undefined) delete globalThis.fetch;
  else globalThis.fetch = previousFetch;
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

test("web credentials stay memory-only and legacy browser copies are purged", () => {
  const previousWindow = globalThis.window;
  const localStorage = storage();
  for (const key of [
    "silicon-interface:access",
    "silicon-interface:refresh",
    "silicon-interface:silicon-key",
    "silicon-chat:access",
    "silicon-chat:refresh",
    "silicon-chat:silicon-key",
  ]) localStorage.setItem(key, `secret-${key}`);
  globalThis.window = {
    localStorage,
    dispatchEvent() {},
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
  };

  purgeStoredCredentials();
  authStore.setTokens("memory-access", "memory-refresh");
  authStore.setSiliconKey("memory-silicon-key");

  assert.equal(authStore.getAccess(), "memory-access");
  assert.equal(authStore.getRefresh(), "memory-refresh");
  assert.equal(authStore.getSiliconKey(), "memory-silicon-key");
  assert.deepEqual([...localStorage.values.keys()], []);
  resetAuthMemory();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

test("clearing browser storage does not revoke active cookie-backed authority", () => {
  const previousWindow = globalThis.window;
  const localStorage = storage();
  globalThis.window = {
    localStorage,
    dispatchEvent() {},
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
  };

  authStore.setTokens("memory-access", "memory-refresh");
  localStorage.values.clear();
  assert.equal(authStore.getAccess(), "memory-access");
  assert.equal(authStore.getRefresh(), "memory-refresh");

  resetAuthMemory();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

test("offline owner cache excludes contact data and bearer profile grants", () => {
  const previousWindow = globalThis.window;
  const localStorage = storage();
  globalThis.window = {
    localStorage,
    dispatchEvent() {},
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
  };
  authStore.setCarbon({
    carbon_id: "owner-1",
    username: "alice",
    email: "alice@example.test",
    phone: "+14155550123",
    name: "Alice",
    profile_photo_key: "profile-icons/private-key.png",
    profile_photo_url: "https://signed.example.test/private-grant",
    profile_ascii_url: "https://signed.example.test/ascii-grant",
    tagline: "hello",
    timezone: "Asia/Kolkata",
    is_staff: false,
    email_verified_at: "2026-01-01T00:00:00Z",
    phone_verified_at: "2026-01-01T00:00:00Z",
    created_at: "2026-01-01T00:00:00Z",
  });

  const raw = localStorage.getItem("silicon-interface:carbon");
  assert.ok(raw);
  assert.equal(raw.includes("alice@example.test"), false);
  assert.equal(raw.includes("+14155550123"), false);
  assert.equal(raw.includes("private-grant"), false);
  assert.equal(raw.includes("private-key"), false);

  // Live subscribers receive the complete server response so a profile edit
  // updates every avatar immediately, while the offline copy remains limited
  // to the non-sensitive identity subset asserted above.
  const live = authStore.getCarbon();
  assert.equal(live.carbon_id, "owner-1");
  assert.equal(live.email, "alice@example.test");
  assert.equal(live.phone, "+14155550123");
  assert.equal(live.profile_photo_url, "https://signed.example.test/private-grant");
  assert.equal(authStore.hasPersistedOwner(), true);
  localStorage.values.clear();
  assert.equal(authStore.hasPersistedOwner(), false);
  assert.equal(authStore.getCarbon().carbon_id, "owner-1");
  resetAuthMemory();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

test("legacy full carbon cache is scrubbed in place", () => {
  const previousWindow = globalThis.window;
  const localStorage = storage();
  localStorage.setItem("silicon-chat:carbon", JSON.stringify({
    carbon_id: "owner-legacy",
    username: "legacy",
    email: "legacy@example.test",
    phone: "+14155550999",
    name: "Legacy",
    profile_photo_url: "https://signed.example.test/legacy-grant",
  }));
  globalThis.window = {
    localStorage,
    dispatchEvent() {},
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
  };

  purgeStoredCredentials();
  const raw = localStorage.getItem("silicon-interface:carbon");
  assert.ok(raw);
  assert.equal(raw.includes("legacy@example.test"), false);
  assert.equal(raw.includes("+14155550999"), false);
  assert.equal(raw.includes("legacy-grant"), false);
  assert.equal(localStorage.getItem("silicon-chat:carbon"), null);
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});
