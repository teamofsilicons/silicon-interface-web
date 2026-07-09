"use client";

import * as React from "react";

import { identifyCarbon, resetAnalytics } from "./analytics";
import type { AuthSession, Carbon } from "./types";
import { clearAllVoiceDrafts, deleteVoiceDraftsForOwner } from "./voice-drafts";

const ACCESS_KEY = "silicon-interface:access";
const REFRESH_KEY = "silicon-interface:refresh";
const CARBON_KEY = "silicon-interface:carbon";
const SILICON_KEY = "silicon-interface:silicon-key";

// One-time migration off the legacy "silicon-chat:" prefix so existing
// sessions survive the rebrand. Runs once at module load.
function migrateLegacyKeys() {
  if (typeof window === "undefined") return;
  // localStorage access can throw in private mode / when storage is disabled.
  // This runs at module load, so an unguarded throw here would brick the whole
  // app (every page imports the auth store). Swallow it.
  try {
    const moves: [string, string][] = [
      ["silicon-chat:access", ACCESS_KEY],
      ["silicon-chat:refresh", REFRESH_KEY],
      ["silicon-chat:carbon", CARBON_KEY],
      ["silicon-chat:silicon-key", SILICON_KEY],
    ];
    for (const [oldKey, newKey] of moves) {
      const v = window.localStorage.getItem(oldKey);
      if (v != null && window.localStorage.getItem(newKey) == null) {
        window.localStorage.setItem(newKey, v);
      }
      if (v != null) window.localStorage.removeItem(oldKey);
    }
  } catch {
    /* storage unavailable — nothing to migrate */
  }
}
migrateLegacyKeys();

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

export const authStore = {
  getAccess: () => safeGet(ACCESS_KEY),
  getRefresh: () => safeGet(REFRESH_KEY),
  getSiliconKey: () => safeGet(SILICON_KEY),
  getCarbon(): Carbon | null {
    const raw = safeGet(CARBON_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Carbon;
    } catch {
      return null;
    }
  },
  setSession(session: AuthSession) {
    safeSet(ACCESS_KEY, session.access);
    safeSet(REFRESH_KEY, session.refresh);
    safeSet(CARBON_KEY, JSON.stringify(session.carbon));
    identifyCarbon(session.carbon);
    emit();
  },
  setTokens(access: string, refresh: string, carbon?: Carbon) {
    safeSet(ACCESS_KEY, access);
    safeSet(REFRESH_KEY, refresh);
    if (carbon) {
      safeSet(CARBON_KEY, JSON.stringify(carbon));
      identifyCarbon(carbon);
    }
    emit();
  },
  setCarbon(carbon: Carbon) {
    safeSet(CARBON_KEY, JSON.stringify(carbon));
    // Keep PostHog person properties fresh (login, profile edits, tz sync).
    identifyCarbon(carbon);
    emit();
  },
  setSiliconKey(key: string | null) {
    safeSet(SILICON_KEY, key);
    emit();
  },
  clear() {
    const carbon = authStore.getCarbon();
    if (carbon?.carbon_id) {
      void deleteVoiceDraftsForOwner(`carbon:${carbon.carbon_id}`).catch(() => undefined);
    } else {
      void clearAllVoiceDrafts().catch(() => undefined);
    }
    safeSet(ACCESS_KEY, null);
    safeSet(REFRESH_KEY, null);
    safeSet(CARBON_KEY, null);
    safeSet(SILICON_KEY, null);
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
