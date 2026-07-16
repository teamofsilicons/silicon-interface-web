// Web Push subscription lifecycle. The server side lives in Glass
// (/api/v1/push/*); the service worker in /public/sw.js renders the banners.

import { api } from "./api";
import { isDesktopShell } from "./desktop-bridge";

export type PushPreviewMode = "full" | "sender" | "none";
const PREVIEW_KEY = "silicon-interface:push-preview";

export function getPushPreviewMode(): PushPreviewMode {
  if (typeof window === "undefined") return "full";
  const value = window.localStorage.getItem(PREVIEW_KEY);
  return value === "sender" || value === "none" ? value : "full";
}

export async function setPushPreviewMode(mode: PushPreviewMode): Promise<void> {
  window.localStorage.setItem(PREVIEW_KEY, mode);
  const sub = await currentSubscription();
  if (sub) await api.pushSubscribe({ ...sub.toJSON(), preview_mode: mode });
}

function base64UrlToUint8(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function pushSupported(): boolean {
  return (
    workerSupported() &&
    !isDesktopShell() &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function workerSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator;
}

export async function registerPushWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!workerSupported()) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
  } catch {
    return null;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

export type EnablePushResult = "enabled" | "denied" | "unsupported" | "unconfigured";

export async function enablePush(): Promise<EnablePushResult> {
  if (!pushSupported()) return "unsupported";
  const { public_key } = await api.pushVapidKey();
  if (!public_key) return "unconfigured";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "denied";
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerPushWorker());
  if (!reg) return "unsupported";
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8(public_key) as BufferSource,
    }));
  await api.pushSubscribe({ ...sub.toJSON(), preview_mode: getPushPreviewMode() });
  return "enabled";
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}

/** True when permission is granted and a live subscription exists. */
export async function isPushEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  return (await currentSubscription()) !== null;
}
