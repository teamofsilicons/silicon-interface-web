"use client";

import * as React from "react";

import { identifyCarbon, resetAnalytics } from "./analytics";
import { env } from "./env";
import type { AuthSession, Carbon } from "./types";

const CARBON_KEY = "silicon-interface:carbon";
let accessToken: string | null = null;
let refreshToken: string | null = null;
let siliconKey: string | null = null;
let explicitlyLoggedOut = false;
// The full Carbon profile is intentionally memory-only. In particular,
// profile_photo_url is a short-lived bearer grant and must not be written to
// localStorage, but live subscribers still need the complete object returned by
// Glass after a profile edit.
let currentCarbon: Carbon | null = null;

type PersistedCarbonIdentity = Pick<
  Carbon,
  "carbon_id" | "username" | "name" | "tagline" | "timezone" | "is_staff"
>;

function persistedCarbonIdentity(carbon: Carbon): PersistedCarbonIdentity {
  return {
    carbon_id: carbon.carbon_id,
    username: carbon.username,
    name: carbon.name,
    tagline: carbon.tagline,
    timezone: carbon.timezone,
    is_staff: carbon.is_staff,
  };
}

function hydratePersistedCarbon(value: unknown): Carbon | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<PersistedCarbonIdentity>;
  if (typeof row.carbon_id !== "string" || !row.carbon_id) return null;
  const username =
    typeof row.username === "string" && row.username ? row.username : row.carbon_id;
  return {
    carbon_id: row.carbon_id,
    username,
    name: typeof row.name === "string" ? row.name : "",
    tagline: typeof row.tagline === "string" ? row.tagline : "",
    timezone: typeof row.timezone === "string" ? row.timezone : "",
    is_staff: row.is_staff === true,
    email: "",
    phone: "",
    profile_photo_key: "",
    profile_photo_url: null,
    profile_ascii_url: null,
    email_verified_at: null,
    phone_verified_at: null,
    created_at: "",
  };
}

// Tokens/API keys previously lived in localStorage. Remove every old copy at
// module load; the HttpOnly refresh cookie restores carbon sessions, while a
// silicon-key session deliberately ends on reload rather than leaving a
// long-lived credential readable to injected JavaScript.
export function purgeStoredCredentials() {
  if (typeof window === "undefined") return;
  // localStorage access can throw in private mode / when storage is disabled.
  // This runs at module load, so an unguarded throw here would brick the whole
  // app (every page imports the auth store). Swallow it.
  try {
    const migrationRefresh =
      window.localStorage.getItem("silicon-interface:refresh")
      ?? window.localStorage.getItem("silicon-chat:refresh");
    if (!refreshToken && migrationRefresh) refreshToken = migrationRefresh;
    const sensitive = [
      "silicon-interface:access",
      "silicon-interface:refresh",
      "silicon-interface:silicon-key",
      "silicon-chat:access",
      "silicon-chat:refresh",
      "silicon-chat:silicon-key",
    ];
    for (const key of sensitive) window.localStorage.removeItem(key);
    const oldCarbon = window.localStorage.getItem("silicon-chat:carbon");
    const currentCarbon = window.localStorage.getItem(CARBON_KEY);
    const candidate = currentCarbon ?? oldCarbon;
    if (candidate) {
      try {
        const carbon = hydratePersistedCarbon(JSON.parse(candidate));
        if (carbon) {
          window.localStorage.setItem(
            CARBON_KEY,
            JSON.stringify(persistedCarbonIdentity(carbon)),
          );
        } else {
          window.localStorage.removeItem(CARBON_KEY);
        }
      } catch {
        window.localStorage.removeItem(CARBON_KEY);
      }
    }
    window.localStorage.removeItem("silicon-chat:carbon");
  } catch {
    /* storage unavailable — nothing to migrate */
  }
}
purgeStoredCredentials();

type Listener = () => void;
const listeners = new Set<Listener>();
function emit() {
  for (const fn of listeners) fn();
}

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable in private mode — best effort */
  }
}

function deviceClaim(token: string | null): string | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const base = payload.replace(/-/g, "+").replace(/_/g, "/");
    const normalized = base.padEnd(Math.ceil(base.length / 4) * 4, "=");
    const parsed = JSON.parse(window.atob(normalized)) as { device_id?: unknown };
    return typeof parsed.device_id === "string" && parsed.device_id ? parsed.device_id : null;
  } catch {
    return null;
  }
}

export const authStore = {
  getAccess: () => accessToken,
  getBoundDeviceId: () => deviceClaim(accessToken),
  getRefresh: () => refreshToken,
  getSiliconKey: () => siliconKey,
  wasExplicitlyLoggedOut: () => explicitlyLoggedOut,
  getCarbon(): Carbon | null {
    if (currentCarbon) return currentCarbon;
    const raw = safeGet(CARBON_KEY);
    if (!raw) return null;
    try {
      // Do not promote the restricted offline identity into the live-profile
      // slot. Reading storage must continue to reflect the current storage
      // owner; only a server response may populate currentCarbon.
      return hydratePersistedCarbon(JSON.parse(raw));
    } catch {
      return null;
    }
  },
  setSession(session: AuthSession) {
    explicitlyLoggedOut = false;
    accessToken = session.access;
    refreshToken = session.refresh ?? null;
    currentCarbon = session.carbon;
    safeSet(CARBON_KEY, JSON.stringify(persistedCarbonIdentity(session.carbon)));
    identifyCarbon(session.carbon);
    emit();
  },
  setTokens(access: string, refresh?: string | null, carbon?: Carbon) {
    explicitlyLoggedOut = false;
    accessToken = access;
    refreshToken = refresh ?? null;
    if (carbon) {
      currentCarbon = carbon;
      safeSet(CARBON_KEY, JSON.stringify(persistedCarbonIdentity(carbon)));
      identifyCarbon(carbon);
    }
    emit();
  },
  setCarbon(carbon: Carbon) {
    currentCarbon = carbon;
    safeSet(CARBON_KEY, JSON.stringify(persistedCarbonIdentity(carbon)));
    // Keep PostHog person properties fresh (login, profile edits, tz sync).
    identifyCarbon(carbon);
    emit();
  },
  setSiliconKey(key: string | null) {
    if (key) explicitlyLoggedOut = false;
    siliconKey = key;
    emit();
  },
  /**
   * Drop stale request authority without revoking the browser session or
   * deleting the known offline owner. A later refresh can restore access.
   */
  expireAccess() {
    accessToken = null;
    refreshToken = null;
    emit();
  },
  clear() {
    explicitlyLoggedOut = true;
    const current = authStore.getCarbon();
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("silicon-interface:auth-clear", {
          detail: { ownerKey: current?.carbon_id ? `carbon:${current.carbon_id}` : null },
        }),
      );
    }
    // Revoke/delete the HttpOnly refresh cookie. This is intentionally
    // fire-and-forget so logout never waits on a network path before clearing
    // the in-memory authority and protected local state.
    if (typeof window !== "undefined") {
      void fetch(`${env.apiBase}/api/v1/auth/logout`, {
        method: "POST",
        credentials: "include",
        headers: { "X-Silicon-Web-Session": "1" },
      }).catch(() => undefined);
    }
    accessToken = null;
    refreshToken = null;
    currentCarbon = null;
    safeSet(CARBON_KEY, null);
    siliconKey = null;
    resetAnalytics();
    emit();
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function useAuth() {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    return authStore.subscribe(() => setTick((n) => n + 1));
  }, []);
  return {
    carbon: authStore.getCarbon(),
    access: authStore.getAccess(),
    refresh: authStore.getRefresh(),
    siliconKey: authStore.getSiliconKey(),
    isAuthed: Boolean(authStore.getAccess() || authStore.getSiliconKey()),
    logout: () => authStore.clear(),
  };
}
