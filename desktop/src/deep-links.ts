import type { DesktopDeepLink } from "./contracts";
import { PRODUCTION_RENDERER_ORIGIN } from "./policy";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const JOIN_TOKEN = /^[A-Za-z0-9_-]{8,256}$/;
const EVENT_ID = /^[A-Za-z0-9:_-]{1,256}$/;

function chatLink(roomId: string, eventId?: string | null): DesktopDeepLink | null {
  if (!ULID.test(roomId)) return null;
  const query = new URLSearchParams({ room: roomId });
  if (eventId) {
    if (!EVENT_ID.test(eventId)) return null;
    query.set("message", eventId);
  }
  return { kind: "chat", path: "/chat?" + query.toString() };
}

function joinLink(token: string): DesktopDeepLink | null {
  if (!JOIN_TOKEN.test(token)) return null;
  return { kind: "join", path: "/join/" + encodeURIComponent(token) };
}

export function parseDeepLink(candidate: string): DesktopDeepLink | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol === "silicon:") {
    if (url.username || url.password || url.port) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "chat" && parts.length === 1) {
      return chatLink(parts[0], url.searchParams.get("message"));
    }
    if (url.hostname === "join" && parts.length === 1 && !url.search) {
      return joinLink(parts[0]);
    }
    return null;
  }

  if (url.origin !== PRODUCTION_RENDERER_ORIGIN || url.username || url.password) return null;
  if (url.pathname === "/chat") {
    const allowed = new Set(["room", "message"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return null;
    const room = url.searchParams.get("room");
    return room ? chatLink(room, url.searchParams.get("message")) : null;
  }

  const match = /^\/join\/([^/]+)\/?$/.exec(url.pathname);
  if (match && !url.search) return joinLink(decodeURIComponent(match[1]));
  return null;
}

export function extractDeepLinkArg(argv: readonly string[]): DesktopDeepLink | null {
  for (const arg of argv) {
    const parsed = parseDeepLink(arg);
    if (parsed) return parsed;
  }
  return null;
}
