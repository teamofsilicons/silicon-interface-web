"use client";

import * as React from "react";

import { env } from "./env";
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

export function useChatSocket({ onFrame, enabled = true }: UseWsOptions = {}): UseWsReturn {
  const [ready, setReady] = React.useState(false);
  const [lastFrame, setLastFrame] = React.useState<WsFrame | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const onFrameRef = React.useRef(onFrame);
  onFrameRef.current = onFrame;

  const pingRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptsRef = React.useRef(0);
  // True only when we tear the socket down on purpose (unmount / token change /
  // manual reconnect) so the close handler doesn't fight us with a retry.
  const intentionalRef = React.useRef(false);

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
    const qs = new URLSearchParams();
    if (siliconKey) qs.set("silicon_key", siliconKey);
    else if (access) qs.set("token", access);
    const url = `${env.wsBase}/ws/v1/?${qs.toString()}`;

    const scheduleReconnect = () => {
      if (intentionalRef.current || !enabled) return;
      const delay = Math.min(1000 * 2 ** attemptsRef.current, MAX_BACKOFF_MS);
      attemptsRef.current += 1;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(() => connect(), delay);
    };

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.addEventListener("open", () => {
        setReady(true);
        attemptsRef.current = 0;
        if (pingRef.current) clearInterval(pingRef.current);
        pingRef.current = setInterval(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
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
