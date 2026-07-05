"use client";

import * as React from "react";

import { env } from "./env";
import { api } from "./api";
import { authStore } from "./auth";
import type { WsFrame } from "./types";

interface UseWsOptions {
  onFrame?: (f: WsFrame) => void;
  enabled?: boolean;
}

interface UseWsReturn {
  ready: boolean;
  lastFrame: WsFrame | null;
  send: (frame: object) => void;
  reconnect: () => void;
}

// Heartbeat keeps idle connections alive (proxies/load-balancers drop silent
// sockets). Backoff caps reconnection attempts after an unexpected drop —
// e.g. a backend restart, a network blip, or a backgrounded tab.
const PING_INTERVAL_MS = 25_000;
const MAX_BACKOFF_MS = 15_000;
// Watchdog: if NOTHING has arrived (no pong, no frames) for this long, the
// socket is dead-but-open (sleeping proxy, dropped uplink with no FIN) —
// force-close it so the close handler's reconnect path takes over.
const STALE_AFTER_MS = PING_INTERVAL_MS * 2.5;
// Ticket-based WS auth: mint a single-use, short-TTL ticket per connect
// attempt so the URL never carries the long-lived JWT. Minting is a plain
// HTTP call (with api.ts's transparent 401-refresh) — it must never wedge the
// reconnect path, so a hung request is raced against this timeout and the
// attempt retries via the normal backoff (the JWT never goes in the URL,
// where proxies and access logs could capture it).
const TICKET_MINT_TIMEOUT_MS = 5_000;

/** Resolve to a ticket string, or null when minting failed/timed out
 *  (network down, 5xx, endpoint not deployed yet). Never rejects. */
function mintTicket(): Promise<string | null> {
  const mint = api
    .wsTicket()
    .then((r) => (typeof r.ticket === "string" && r.ticket ? r.ticket : null))
    .catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), TICKET_MINT_TIMEOUT_MS);
  });
  return Promise.race([mint, timeout]);
}

export function useChatSocket({ onFrame, enabled = true }: UseWsOptions = {}): UseWsReturn {
  const [ready, setReady] = React.useState(false);
  const [lastFrame, setLastFrame] = React.useState<WsFrame | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const onFrameRef = React.useRef(onFrame);
  onFrameRef.current = onFrame;

  const pingRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // Last time ANY message arrived — pongs included. Drives the stale watchdog.
  // Stamped on `open`, so the 0 initial value never trips the check.
  const lastActivityRef = React.useRef(0);
  const reconnectRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = React.useRef(0);
  // True only when we tear the socket down on purpose (unmount / token change /
  // manual reconnect) so the close handler doesn't fight us with a retry.
  const intentionalRef = React.useRef(false);
  // Monotonic id per connect() call. The token path awaits an async ticket
  // mint before opening the socket; if another connect started (or a teardown
  // happened) while we were waiting, the stale attempt must abort instead of
  // stacking a second socket.
  const connectSeqRef = React.useRef(0);

  const clearTimers = React.useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current);
      pingRef.current = null;
    }
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
  }, []);

  const connect = React.useCallback(() => {
    if (!enabled) return;
    // Already have a live/connecting socket — don't stack a second one.
    const existing = wsRef.current;
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN ||
        existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    const access = authStore.getAccess();
    const siliconKey = authStore.getSiliconKey();
    if (!access && !siliconKey) return;
    intentionalRef.current = false;
    const seq = ++connectSeqRef.current;

    const scheduleReconnect = () => {
      if (intentionalRef.current || !enabled) return;
      const delay = Math.min(1000 * 2 ** attemptsRef.current, MAX_BACKOFF_MS);
      attemptsRef.current += 1;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(() => connect(), delay);
    };

    const wsUrl = (params: Record<string, string>) =>
      `${env.wsBase}/ws/v1/?${new URLSearchParams(params).toString()}`;

    const open = (url: string) => {
      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.addEventListener("open", () => {
          setReady(true);
          attemptsRef.current = 0;
          lastActivityRef.current = Date.now();
          if (pingRef.current) clearInterval(pingRef.current);
          pingRef.current = setInterval(() => {
            try {
              if (ws.readyState === WebSocket.OPEN) {
                // No pong (or any other frame) since well before the last ping —
                // the connection is silently dead. Close it; the close handler
                // schedules the reconnect.
                if (Date.now() - lastActivityRef.current > STALE_AFTER_MS) {
                  ws.close();
                  return;
                }
                ws.send(JSON.stringify({ type: "ping" }));
              }
            } catch {
              /* ignore */
            }
          }, PING_INTERVAL_MS);
        });
        ws.addEventListener("close", () => {
          setReady(false);
          if (wsRef.current === ws) wsRef.current = null;
          if (pingRef.current) {
            clearInterval(pingRef.current);
            pingRef.current = null;
          }
          scheduleReconnect();
        });
        ws.addEventListener("error", () => {
          // a `close` event always follows — reconnection is handled there.
        });
        ws.addEventListener("message", (e) => {
          lastActivityRef.current = Date.now();
          try {
            const f = JSON.parse(e.data) as WsFrame;
            setLastFrame(f);
            onFrameRef.current?.(f);
          } catch {
            // ignore malformed frame
          }
        });
      } catch {
        scheduleReconnect();
      }
    };

    // Silicon-key connections keep their existing query auth.
    if (siliconKey) {
      open(wsUrl({ silicon_key: siliconKey }));
      return;
    }

    // Carbon (JWT) connections: mint a FRESH single-use ticket per attempt and
    // connect with `?ticket=`. A mint failure retries via backoff — the JWT is
    // never placed in the URL.
    void mintTicket().then((ticket) => {
      // A teardown (unmount / token change / manual reconnect) or a newer
      // connect attempt happened while we were minting — abort this one.
      if (intentionalRef.current || !enabled) return;
      if (seq !== connectSeqRef.current) return;
      const current = wsRef.current;
      if (
        current &&
        (current.readyState === WebSocket.OPEN ||
          current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }
      if (ticket) {
        open(wsUrl({ ticket }));
        return;
      }
      // Mint failed (offline / transient 5xx): back off and retry.
      scheduleReconnect();
    });
  }, [enabled]);

  React.useEffect(() => {
    connect();
    return () => {
      intentionalRef.current = true;
      clearTimers();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled, connect, clearTimers]);

  // Reconnect when the auth token changes.
  React.useEffect(() => {
    return authStore.subscribe(() => {
      intentionalRef.current = true;
      clearTimers();
      wsRef.current?.close();
      wsRef.current = null;
      setReady(false);
      attemptsRef.current = 0;
      setTimeout(() => connect(), 50);
    });
  }, [connect, clearTimers]);

  // Recover immediately when the tab regains focus or the network comes back —
  // backgrounded tabs and sleep often drop the socket without a timely close.
  React.useEffect(() => {
    if (!enabled) return;
    const wake = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        attemptsRef.current = 0;
        connect();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") wake();
    };
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [connect, enabled]);

  const send = React.useCallback((frame: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }, []);

  const reconnect = React.useCallback(() => {
    clearTimers();
    intentionalRef.current = true;
    wsRef.current?.close();
    wsRef.current = null;
    attemptsRef.current = 0;
    setTimeout(() => connect(), 50);
  }, [connect, clearTimers]);

  return { ready, lastFrame, send, reconnect };
}
