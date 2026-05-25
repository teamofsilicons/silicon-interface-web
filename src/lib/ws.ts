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

export function useChatSocket({ onFrame, enabled = true }: UseWsOptions = {}): UseWsReturn {
  const [ready, setReady] = React.useState(false);
  const [lastFrame, setLastFrame] = React.useState<WsFrame | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const onFrameRef = React.useRef(onFrame);
  onFrameRef.current = onFrame;

  const connect = React.useCallback(() => {
    if (!enabled) return;
    const access = authStore.getAccess();
    const siliconKey = authStore.getSiliconKey();
    if (!access && !siliconKey) return;
    const qs = new URLSearchParams();
    if (siliconKey) qs.set("silicon_key", siliconKey);
    else if (access) qs.set("token", access);
    const url = `${env.wsBase}/ws/v1/?${qs.toString()}`;
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.addEventListener("open", () => setReady(true));
      ws.addEventListener("close", () => {
        setReady(false);
        wsRef.current = null;
      });
      ws.addEventListener("error", () => {
        // browser will fire close after
      });
      ws.addEventListener("message", (e) => {
        try {
          const f = JSON.parse(e.data) as WsFrame;
          setLastFrame(f);
          onFrameRef.current?.(f);
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }
  }, [enabled]);

  React.useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Reconnect when token changes
  React.useEffect(() => {
    return authStore.subscribe(() => {
      wsRef.current?.close();
      wsRef.current = null;
      setReady(false);
      // small delay so close fires
      setTimeout(connect, 50);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = React.useCallback((frame: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }, []);

  const reconnect = React.useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setTimeout(connect, 50);
  }, [connect]);

  return { ready, lastFrame, send, reconnect };
}
