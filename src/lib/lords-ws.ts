"use client";

import * as React from "react";

import { api } from "./api";
import { env } from "./env";

export interface LordWake {
  type: "wake";
  reason: string;
  room_id: string;
  event_id: string;
}

export function useLordSocket(enabled: boolean, onWake: (wake: LordWake) => void) {
  const wakeRef = React.useRef(onWake);
  const [connected, setConnected] = React.useState(false);

  React.useEffect(() => {
    wakeRef.current = onWake;
  }, [onWake]);

  React.useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let socket: WebSocket | null = null;
    let reconnect: number | null = null;
    let heartbeat: number | null = null;
    let attempt = 0;

    const clearHeartbeat = () => {
      if (heartbeat !== null) window.clearInterval(heartbeat);
      heartbeat = null;
    };
    const schedule = () => {
      if (!alive || reconnect !== null) return;
      const delay = Math.min(15_000, 700 * 2 ** Math.min(attempt++, 5));
      reconnect = window.setTimeout(() => {
        reconnect = null;
        void connect();
      }, delay);
    };
    const connect = async () => {
      if (!alive) return;
      try {
        const { ticket } = await api.lordWsTicket();
        if (!alive) return;
        socket = new WebSocket(`${env.wsBase}/ws/v1/lords/?ticket=${encodeURIComponent(ticket)}`);
        socket.onopen = () => {
          attempt = 0;
          setConnected(true);
          clearHeartbeat();
          heartbeat = window.setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "heartbeat" }));
            }
          }, 20_000);
        };
        socket.onmessage = (message) => {
          try {
            const frame = JSON.parse(String(message.data)) as LordWake | { type?: string };
            if (frame.type === "wake") wakeRef.current(frame as LordWake);
          } catch {
            // A malformed frame is isolated; the next authoritative refetch wins.
          }
        };
        socket.onerror = () => socket?.close();
        socket.onclose = () => {
          setConnected(false);
          clearHeartbeat();
          schedule();
        };
      } catch {
        setConnected(false);
        schedule();
      }
    };
    void connect();
    return () => {
      alive = false;
      if (reconnect !== null) window.clearTimeout(reconnect);
      clearHeartbeat();
      socket?.close();
    };
  }, [enabled]);

  return connected;
}
