"use client";

import { api } from "./api";
import { authStore } from "./auth";
import { deviceId } from "./device-id";

let registrationInflight: Promise<boolean> | null = null;

function platform(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("android")) return "android";
  if (ua.includes("iphone") || ua.includes("ipad")) return "ios";
  if (ua.includes("mac")) return "macos";
  if (ua.includes("win")) return "windows";
  return "linux";
}

function deviceName(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || navigator.platform || "Web browser";
}

/** Upgrade a legacy login JWT to an installation-bound, revocable token pair. */
export function ensureDeviceRegistration(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (!authStore.getAccess() || authStore.getSiliconKey()) return Promise.resolve(false);
  if (authStore.getBoundDeviceId()) return Promise.resolve(true);
  if (registrationInflight) return registrationInflight;
  registrationInflight = api
    .registerDevice({
      device_id: deviceId(),
      platform: platform(),
      name: deviceName(),
      capabilities: {
        event_cursor_v1: true,
        account_cursor_v1: true,
        explicit_delivery_ack: true,
        cloud_drafts_v1: true,
      },
    })
    .then((session) => {
      authStore.setTokens(
        session.access,
        session.refresh,
        authStore.getCarbon() ?? undefined,
      );
      return true;
    })
    .catch(() => false)
    .finally(() => {
      registrationInflight = null;
    });
  return registrationInflight;
}
