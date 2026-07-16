import type { WebContents } from "electron";

export type DesktopPermission =
  | "media"
  | "notifications"
  | "fullscreen"
  | "clipboard-sanitized-write";

export const PRODUCTION_RENDERER_URL = "https://interface.teamofsilicons.com/";
export const PRODUCTION_RENDERER_ORIGIN = new URL(PRODUCTION_RENDERER_URL).origin;
export const UPDATE_FEED_BASE = "https://downloads.teamofsilicons.com/interface/stable";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const ALLOWED_PERMISSIONS = new Set<string>([
  "media",
  "notifications",
  "fullscreen",
  "clipboard-sanitized-write",
]);
const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
const MAX_FILENAME_UTF16_UNITS = 180;
const MAX_FILENAME_UTF8_BYTES = 220;

function takeFilenamePrefix(value: string, maxUtf16Units: number, maxUtf8Bytes: number): string {
  let result = "";
  let bytes = 0;
  for (const codePoint of value) {
    const nextBytes = Buffer.byteLength(codePoint, "utf8");
    if (result.length + codePoint.length > maxUtf16Units || bytes + nextBytes > maxUtf8Bytes) break;
    result += codePoint;
    bytes += nextBytes;
  }
  return result;
}

function boundedFilename(value: string): string {
  if (
    value.length <= MAX_FILENAME_UTF16_UNITS &&
    Buffer.byteLength(value, "utf8") <= MAX_FILENAME_UTF8_BYTES
  ) {
    return value;
  }

  const dot = value.lastIndexOf(".");
  const possibleExtension = dot > 0 && value.length - dot <= 21 ? value.slice(dot) : "";
  const extension =
    possibleExtension.length <= MAX_FILENAME_UTF16_UNITS &&
    Buffer.byteLength(possibleExtension, "utf8") <= MAX_FILENAME_UTF8_BYTES
      ? possibleExtension
      : "";
  const base = extension ? value.slice(0, -extension.length) : value;
  return (
    takeFilenamePrefix(
      base,
      MAX_FILENAME_UTF16_UNITS - extension.length,
      MAX_FILENAME_UTF8_BYTES - Buffer.byteLength(extension, "utf8"),
    ) + extension
  );
}

export function resolveRendererUrl(
  production: boolean,
  requested = process.env.SILICON_DESKTOP_URL,
): string {
  if (production || !requested) return PRODUCTION_RENDERER_URL;

  const parsed = new URL(requested);
  if (parsed.origin === PRODUCTION_RENDERER_ORIGIN) return parsed.href;
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && LOCAL_HOSTS.has(parsed.hostname)) {
    return parsed.href;
  }
  throw new Error("SILICON_DESKTOP_URL must use the production origin or loopback in development");
}

export function rendererOrigin(rendererUrl: string): string {
  return new URL(rendererUrl).origin;
}

export function isTrustedRendererUrl(candidate: string, trustedOrigin: string): boolean {
  try {
    const url = new URL(candidate);
    return url.origin === trustedOrigin && (url.protocol === "https:" || LOCAL_HOSTS.has(url.hostname));
  } catch {
    return false;
  }
}

export function isTrustedSender(sender: WebContents, senderUrl: string, trustedOrigin: string): boolean {
  return sender.mainFrame.url === senderUrl && isTrustedRendererUrl(senderUrl, trustedOrigin);
}

export function safeExternalUrl(candidate: string): string | null {
  try {
    if (/[\u0000-\u001f\u007f]/.test(candidate)) return null;
    const url = new URL(candidate);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function safeDownloadUrl(candidate: string, trustedOrigin: string): string | null {
  try {
    if (/[\u0000-\u001f\u007f]/.test(candidate)) return null;
    const url = new URL(candidate);
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.href;
    if (url.protocol === "http:" && url.origin === trustedOrigin && LOCAL_HOSTS.has(url.hostname)) {
      return url.href;
    }
    return null;
  } catch {
    return null;
  }
}

export function safeSuggestedFilename(candidate: unknown): string {
  if (typeof candidate !== "string") return "download";
  const leaf = candidate.split(/[\\/]/).pop();
  if (!leaf) return "download";
  let safe = leaf
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .trim()
    .replace(/[ .]+$/g, "");
  if (!safe || safe === "." || safe === "..") return "download";

  // Windows reserves these stems even when an extension follows (CON.txt,
  // LPT1.log, and so on). Prefixing keeps the user's visible name without
  // allowing the native Save dialog to target a device namespace.
  const stem = safe.split(".", 1)[0];
  if (WINDOWS_RESERVED_FILENAME.test(stem)) safe = `_${safe}`;

  safe = boundedFilename(safe).replace(/[ .]+$/g, "");
  return safe || "download";
}

export function permissionAllowed(
  permission: string,
  requestingOrigin: string,
  trustedOrigin: string,
  isMainFrame: boolean,
): boolean {
  return isMainFrame && requestingOrigin === trustedOrigin && ALLOWED_PERMISSIONS.has(permission);
}

export function normalizeBadgeCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(99_999, Math.max(0, Math.trunc(value)));
}

/** Keep every signed architecture on an independent update metadata path.
 * This prevents one CI build from overwriting another architecture's
 * latest.yml/latest-mac.yml file. The renderer cannot influence this URL. */
export function updateFeedUrl(platform: NodeJS.Platform, arch: string): string | null {
  if (platform !== "darwin" && platform !== "win32") return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  return `${UPDATE_FEED_BASE}/${platform}/${arch}`;
}
