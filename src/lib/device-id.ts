"use client";

const DEVICE_ID_KEY = "silicon-interface:device-id";

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function deviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const next = randomId();
    window.localStorage.setItem(DEVICE_ID_KEY, next);
    return next;
  } catch {
    return "memory-device";
  }
}
