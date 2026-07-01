"use client";

import * as React from "react";

import { provisionWsUrl } from "./api";

/** Frames the provisioning consumer sends to the Interface. */
export type ProvisionFrame =
  | { type: "snapshot"; session: unknown }
  | { type: "status"; status: string; step: string; error: string }
  | { type: "assistant"; text: string }
  | { type: "command.started"; command: string; purpose: string }
  | { type: "command.output"; data: string }
  | { type: "command.done"; exit_status: number }
  | { type: "phase.done"; phase: string; ok: boolean; summary: string }
  | { type: "terminal.output"; data: string }
  | { type: "terminal.closed" }
  | { type: "error"; detail: string };

interface Options {
  sessionId: string | null;
  onFrame?: (f: ProvisionFrame) => void;
  enabled?: boolean;
}

interface Return {
  ready: boolean;
  send: (frame: object) => void;
  reconnect: () => void;
}

const MAX_BACKOFF_MS = 15_000;

/**
 * A dedicated socket for one SetupSession's provisioning channel. Unlike the
 * chat socket this is short-lived (open while the wizard step is active) and
 * carries the SSH agent + terminal frames. Reconnects with backoff so a blip
 * mid-install doesn't strand the wizard.
 */
export function useProvisionSocket({ sessionId, onFrame, enabled = true }: Options): Return {
  const [ready, setReady] = React.useState(false);
  const wsRef = React.useRef<WebSocket | null>(null);
  const onFrameRef = React.useRef(onFrame);
  onFrameRef.current = onFrame;
  const attemptRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedRef = React.useRef(false);

  const connect = React.useCallback(() => {
    if (!sessionId || !enabled) return;
    closedRef.current = false;
    const ws = new WebSocket(provisionWsUrl(sessionId));
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
      setReady(true);
    };
    ws.onmessage = (ev) => {
      let frame: ProvisionFrame | null = null;
      try {
        frame = JSON.parse(ev.data) as ProvisionFrame;
      } catch {
        return;
      }
      if (frame) onFrameRef.current?.(frame);
    };
    ws.onclose = () => {
      setReady(false);
      wsRef.current = null;
      if (closedRef.current || !enabled) return;
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** attemptRef.current);
      attemptRef.current += 1;
      timerRef.current = setTimeout(connect, delay);
    };
    ws.onerror = () => ws.close();
  }, [sessionId, enabled]);

  React.useEffect(() => {
    connect();
    return () => {
      closedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const send = React.useCallback((frame: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }, []);

  const reconnect = React.useCallback(() => {
    attemptRef.current = 0;
    wsRef.current?.close();
    connect();
  }, [connect]);

  return { ready, send, reconnect };
}
