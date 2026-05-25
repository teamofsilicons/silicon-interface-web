"use client";

import * as React from "react";

import type { AuthSession, Carbon } from "./types";

const ACCESS_KEY = "silicon-chat:access";
const REFRESH_KEY = "silicon-chat:refresh";
const CARBON_KEY = "silicon-chat:carbon";
const SILICON_KEY = "silicon-chat:silicon-key";

type Listener = () => void;
const listeners = new Set<Listener>();
function emit() {
  for (const fn of listeners) fn();
}

function safeGet(key: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(key);
}
function safeSet(key: string, value: string | null) {
  if (typeof window === "undefined") return;
  if (value == null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, value);
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
    emit();
  },
  setTokens(access: string, refresh: string, carbon?: Carbon) {
    safeSet(ACCESS_KEY, access);
    safeSet(REFRESH_KEY, refresh);
    if (carbon) safeSet(CARBON_KEY, JSON.stringify(carbon));
    emit();
  },
  setCarbon(carbon: Carbon) {
    safeSet(CARBON_KEY, JSON.stringify(carbon));
    emit();
  },
  setSiliconKey(key: string | null) {
    safeSet(SILICON_KEY, key);
    emit();
  },
  clear() {
    safeSet(ACCESS_KEY, null);
    safeSet(REFRESH_KEY, null);
    safeSet(CARBON_KEY, null);
    safeSet(SILICON_KEY, null);
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
