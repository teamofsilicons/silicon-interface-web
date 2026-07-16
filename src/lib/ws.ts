"use client";

import * as React from "react";

import { env } from "./env";
import { api } from "./api";
import { authStore } from "./auth";
import type { HeldSend, WsFrame } from "./types";
import { SyncBarrierBuffer } from "./sync-barrier-buffer";
import { protocolCompatibility } from "./protocol-window";
import {
  heldSendMaySchedule,
  heldSendScheduleDelayMs,
  heldSendScheduleSignature,
} from "./held-send-state";
import { acceptSocketHelloOnce, type SocketHelloState } from "./ws-handshake";
import {
  CLIENT_SYNC_REPAIR_CLOSE_CODE,
  DEFAULT_HEARTBEAT_POLICY,
  heartbeatAction,
  normalizeHeartbeatPolicy,
  socketCloseAction,
  type HeartbeatPolicy,
} from "./liveness-policy";
import { probeApiConnectivity } from "./connectivity-classifier";

interface UseWsOptions {
  onFrame?: (f: WsFrame) => void;
  onBarrier?: (
    hello: Extract<WsFrame, { type: "hello" }>,
    context: { generation: number; signal: AbortSignal },
  ) => Promise<void>;
  enabled?: boolean;
}

interface UseWsReturn {
  ready: boolean;
  lastFrame: WsFrame | null;
  send: (frame: object) => void;
  reconnect: () => void;
  state:
    | "offline"
    | "captive"
    | "degraded"
    | "connecting"
    | "authenticating"
    | "syncing"
    | "online";
}

// Heartbeat keeps idle connections alive (proxies/load-balancers drop silent
// sockets). Backoff caps reconnection attempts after an unexpected drop —
// e.g. a backend restart, a network blip, or a backgrounded tab.
const MAX_BACKOFF_MS = 15_000;
// Ticket-based WS auth: mint a single-use, short-TTL ticket per connect
// attempt so the URL never carries the long-lived JWT. Minting is a plain
// HTTP call (with api.ts's transparent 401-refresh) — it must never wedge the
// reconnect path, so a hung request is raced against this timeout and the
// attempt retries via the normal backoff (the JWT never goes in the URL,
// where proxies and access logs could capture it).
const TICKET_MINT_TIMEOUT_MS = 5_000;
const HELD_SEND_SYNC_MS = 15_000;
const HELD_SEND_RETRY_MS = 2_000;
const MAX_BUFFERED_FRAMES = 1_000;

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

export function useChatSocket({ onFrame, onBarrier, enabled = true }: UseWsOptions = {}): UseWsReturn {
  const [ready, setReady] = React.useState(false);
  const [state, setState] = React.useState<UseWsReturn["state"]>("offline");
  const [lastFrame, setLastFrame] = React.useState<WsFrame | null>(null);
  const wsRef = React.useRef<WebSocket | null>(null);
  const onFrameRef = React.useRef(onFrame);
  const onBarrierRef = React.useRef(onBarrier);
  React.useLayoutEffect(() => {
    onFrameRef.current = onFrame;
    onBarrierRef.current = onBarrier;
  }, [onBarrier, onFrame]);
  const barrierBufferRef = React.useRef(new SyncBarrierBuffer<WsFrame>(MAX_BUFFERED_FRAMES));
  const barrierAbortRef = React.useRef<AbortController | null>(null);
  const onlineRef = React.useRef(false);
  const foregroundRef = React.useRef(false);

  const pingRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // Last time ANY message arrived — pongs included. Drives the stale watchdog.
  // Stamped on `open`, so the 0 initial value never trips the check.
  const lastActivityRef = React.useRef(0);
  const heartbeatPolicyRef = React.useRef<HeartbeatPolicy>(DEFAULT_HEARTBEAT_POLICY);
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
  const connectFnRef = React.useRef<() => void>(() => {});
  // Held-send recovery is deliberately socket/page scoped, not RoomView
  // scoped. Switching chats remounts RoomView; this ref survives and keeps the
  // original message's authoritative release timer alive.
  const heldFrameRef = React.useRef<(held: HeldSend) => void>(() => {});

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
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setReady(false);
      setState("offline");
      return;
    }
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
    setState("connecting");
    const seq = ++connectSeqRef.current;

    const scheduleReconnect = () => {
      if (intentionalRef.current || !enabled) return;
      const base = Math.min(1000 * 2 ** attemptsRef.current, MAX_BACKOFF_MS);
      const delay = Math.round(base * (0.5 + Math.random()));
      attemptsRef.current += 1;
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      reconnectRef.current = setTimeout(() => connectFnRef.current(), delay);
    };

    const wsUrl = (params: Record<string, string>) =>
      `${env.wsBase}/ws/v1/?${new URLSearchParams(params).toString()}`;

    const open = (url: string) => {
      try {
        const ws = new WebSocket(url);
        const helloState: SocketHelloState = { received: false };
        wsRef.current = ws;
        const restartHeartbeat = () => {
          if (pingRef.current) clearInterval(pingRef.current);
          const tick = () => {
            try {
              const action = heartbeatAction({
                networkAvailable: navigator.onLine !== false,
                socketOpen: ws.readyState === WebSocket.OPEN,
                waking: false,
                elapsedMs: performance.now() - lastActivityRef.current,
                policy: heartbeatPolicyRef.current,
              });
              if (action === "reconnect") ws.close(4408, "heartbeat timeout");
              else if (action === "ping") ws.send(JSON.stringify({ type: "ping" }));
            } catch {
              /* close/error handlers own recovery */
            }
          };
          pingRef.current = setInterval(tick, heartbeatPolicyRef.current.intervalMs);
        };
        ws.addEventListener("open", () => {
          setReady(false);
          setState("authenticating");
          onlineRef.current = false;
          // Buffer anything arriving after TCP open until hello's authoritative
          // event/account barriers have both been drained.
          barrierBufferRef.current.start();
          heartbeatPolicyRef.current = DEFAULT_HEARTBEAT_POLICY;
          lastActivityRef.current = performance.now();
          restartHeartbeat();
        });
        ws.addEventListener("close", (event) => {
          if (wsRef.current !== ws) return;
          setReady(false);
          if (navigator.onLine === false) {
            setState("offline");
          } else {
            setState("degraded");
            void probeApiConnectivity().then((classification) => {
              if (wsRef.current !== null || onlineRef.current) return;
              setState(classification === "reachable" ? "degraded" : classification);
            });
          }
          onlineRef.current = false;
          barrierBufferRef.current.reset();
          barrierAbortRef.current?.abort();
          barrierAbortRef.current = null;
          if (wsRef.current === ws) wsRef.current = null;
          if (pingRef.current) {
            clearInterval(pingRef.current);
            pingRef.current = null;
          }
          const closeAction = socketCloseAction({
            code: event.code,
            networkAvailable: navigator.onLine !== false,
            wanted: !intentionalRef.current && enabled,
          });
          if (closeAction === "reconnect_and_sync") scheduleReconnect();
        });
        ws.addEventListener("error", () => {
          // a `close` event always follows — reconnection is handled there.
        });
        ws.addEventListener("message", (e) => {
          if (wsRef.current !== ws) return;
          lastActivityRef.current = performance.now();
          try {
            const f = JSON.parse(e.data) as WsFrame;
            if (f.type === "hello") {
              const accepted = acceptSocketHelloOnce(helloState, {
                abortBarrier: () => {
                  barrierAbortRef.current?.abort();
                  barrierAbortRef.current = null;
                },
                invalidateGeneration: () => {
                  connectSeqRef.current += 1;
                },
                resetBuffer: () => barrierBufferRef.current.reset(),
                close: (code, reason) => ws.close(code, reason),
              });
              if (!accepted) {
                onlineRef.current = false;
                setReady(false);
                setState("offline");
                return;
              }
              if (
                protocolCompatibility(
                  1,
                  f.protocol_min ?? 1,
                  f.protocol_max ?? f.protocol_version ?? 1,
                ) !== "compatible"
              ) {
                ws.close(1008, "protocol incompatible");
                return;
              }
              heartbeatPolicyRef.current = normalizeHeartbeatPolicy(
                f.heartbeat_interval_ms ?? DEFAULT_HEARTBEAT_POLICY.intervalMs,
                f.heartbeat_timeout_ms ?? DEFAULT_HEARTBEAT_POLICY.timeoutMs,
              );
              restartHeartbeat();
              setState("syncing");
              const barrierSeq = connectSeqRef.current;
              barrierAbortRef.current?.abort();
              const barrierController = new AbortController();
              barrierAbortRef.current = barrierController;
              void Promise.resolve(onBarrierRef.current?.(f, {
                generation: barrierSeq,
                signal: barrierController.signal,
              }))
                .then(() => {
                  if (
                    barrierController.signal.aborted ||
                    barrierSeq !== connectSeqRef.current ||
                    wsRef.current !== ws
                  ) return;
                  onlineRef.current = true;
                  attemptsRef.current = 0;
                  const buffered = barrierBufferRef.current.release();
                  for (const frame of buffered) {
                    if (frame.type === "held_send") heldFrameRef.current(frame.held_send);
                    onFrameRef.current?.(frame);
                  }
                  setReady(true);
                  setState("online");
                  const foreground =
                    document.visibilityState === "visible" && document.hasFocus();
                  foregroundRef.current = foreground;
                  try {
                    ws.send(JSON.stringify({
                      type: "presence",
                      state: foreground ? "active" : "inactive",
                    }));
                  } catch {
                    /* chat remains authoritative; lease expires safely */
                  }
                })
                .catch(() => {
                  if (!barrierController.signal.aborted && wsRef.current === ws) {
                    ws.close(CLIENT_SYNC_REPAIR_CLOSE_CODE, "sync failed");
                  }
                });
              return;
            }
            if (!onlineRef.current) {
              const offered = barrierBufferRef.current.offer(f, f.type === "pong");
              if (offered === "ignored" || offered === "buffered") return;
              if (offered === "overflow") {
                ws.close(CLIENT_SYNC_REPAIR_CLOSE_CODE, "sync buffer overflow");
                return;
              }
            }
            if (f.type === "held_send") heldFrameRef.current(f.held_send);
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
      // Mint failed. Distinguish no route, captive interception, and reachable
      // HTTPS with a degraded WS/auth path; HTTPS sync may still repair the last.
      void probeApiConnectivity().then((classification) => {
        if (seq !== connectSeqRef.current || intentionalRef.current) return;
        if (classification !== "reachable") setState(classification);
        else setState("degraded");
      });
      scheduleReconnect();
    });
  }, [enabled]);
  React.useLayoutEffect(() => {
    connectFnRef.current = connect;
  }, [connect]);

  React.useEffect(() => {
    const initialConnect = setTimeout(connect, 0);
    return () => {
      clearTimeout(initialConnect);
      intentionalRef.current = true;
      barrierAbortRef.current?.abort();
      barrierAbortRef.current = null;
      clearTimers();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [enabled, connect, clearTimers]);

  // Reconnect when the auth token changes.
  React.useEffect(() => {
    return authStore.subscribe(() => {
      intentionalRef.current = true;
      barrierAbortRef.current?.abort();
      barrierAbortRef.current = null;
      clearTimers();
      wsRef.current?.close();
      wsRef.current = null;
      setReady(false);
      setState("offline");
      onlineRef.current = false;
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
      const socketOpen = ws?.readyState === WebSocket.OPEN;
      const action = heartbeatAction({
        networkAvailable: navigator.onLine !== false,
        socketOpen,
        waking: true,
        elapsedMs: performance.now() - lastActivityRef.current,
        policy: heartbeatPolicyRef.current,
      });
      if (action === "reconnect" && socketOpen) {
        attemptsRef.current = 0;
        ws.close(1000, "wake liveness check");
      } else if (action === "reconnect") {
        attemptsRef.current = 0;
        connect();
      } else if (action === "ping" && socketOpen) {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* close owns recovery */ }
      }
    };
    const onOffline = () => {
      setReady(false);
      setState("offline");
      wsRef.current?.close(1001, "network unavailable");
    };
    const classifyWake = () => {
      void probeApiConnectivity().then((classification) => {
        if (classification === "reachable") wake();
        else {
          setReady(false);
          setState(classification);
          wsRef.current?.close(1001, "network path not usable");
        }
      });
    };
    const publishForeground = () => {
      const foreground =
        document.visibilityState === "visible" && document.hasFocus();
      if (foreground === foregroundRef.current) return;
      foregroundRef.current = foreground;
      const ws = wsRef.current;
      if (onlineRef.current && ws?.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: "presence",
            state: foreground ? "active" : "inactive",
          }));
        } catch {
          /* disconnect/lease expiry owns recovery */
        }
      }
      if (foreground) wake();
    };
    window.addEventListener("online", classifyWake);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", publishForeground);
    window.addEventListener("blur", publishForeground);
    document.addEventListener("visibilitychange", publishForeground);
    return () => {
      window.removeEventListener("online", classifyWake);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("focus", publishForeground);
      window.removeEventListener("blur", publishForeground);
      document.removeEventListener("visibilitychange", publishForeground);
    };
  }, [connect, enabled]);

  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const timers = new Map<string, number>();
    const timerSignatures = new Map<string, string>();
    const releasing = new Set<string>();

    const clearHeldTimer = (heldSendId: string) => {
      const timer = timers.get(heldSendId);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(heldSendId);
      timerSignatures.delete(heldSendId);
    };

    async function requestRelease(held: HeldSend) {
      if (cancelled || releasing.has(held.held_send_id)) return;
      releasing.add(held.held_send_id);
      try {
        const next = await api.sendHeldNow(held.room_id, held.held_send_id);
        releasing.delete(held.held_send_id);
        if (!cancelled) schedule(next);
      } catch {
        releasing.delete(held.held_send_id);
        if (cancelled) return;
        const retry = window.setTimeout(() => schedule(held), HELD_SEND_RETRY_MS);
        timers.set(held.held_send_id, retry);
        timerSignatures.set(
          held.held_send_id,
          heldSendScheduleSignature(held),
        );
      }
    }

    function schedule(held: HeldSend) {
      if (!heldSendMaySchedule(held)) {
        clearHeldTimer(held.held_send_id);
        releasing.delete(held.held_send_id);
        return;
      }
      if (releasing.has(held.held_send_id)) return;
      const signature = heldSendScheduleSignature(held);
      if (
        timers.has(held.held_send_id) &&
        timerSignatures.get(held.held_send_id) === signature
      ) {
        return;
      }
      clearHeldTimer(held.held_send_id);
      // Use server-relative duration, never its absolute wall clock. A browser
      // clock that is ahead/behind cannot turn five seconds into zero or sixty.
      // Unchanged poll rows retain the original timer; user extensions change
      // the version/signature and replace it. Releasing rows get a short grace
      // before send-now reclaims a dead worker.
      const delay = heldSendScheduleDelayMs(held);
      const timer = window.setTimeout(() => {
        timers.delete(held.held_send_id);
        timerSignatures.delete(held.held_send_id);
        void requestRelease(held);
      }, delay);
      timers.set(held.held_send_id, timer);
      timerSignatures.set(held.held_send_id, signature);
    }

    const sync = async () => {
      try {
        const result = await api.heldSendsAll();
        if (cancelled) return;
        const active = new Set(result.held_sends.map((held) => held.held_send_id));
        for (const heldSendId of timers.keys()) {
          if (!active.has(heldSendId)) clearHeldTimer(heldSendId);
        }
        for (const held of result.held_sends) schedule(held);
      } catch {
        // Offline/auth transitions retry on the interval and wake events below.
      }
    };

    heldFrameRef.current = schedule;
    void sync();
    const interval = window.setInterval(() => void sync(), HELD_SEND_SYNC_MS);
    const wake = () => void sync();
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
    return () => {
      cancelled = true;
      heldFrameRef.current = () => {};
      window.clearInterval(interval);
      window.removeEventListener("online", wake);
      window.removeEventListener("focus", wake);
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
      releasing.clear();
    };
  }, [enabled]);

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
    barrierBufferRef.current.reset();
    barrierAbortRef.current?.abort();
    barrierAbortRef.current = null;
    onlineRef.current = false;
    setReady(false);
    setState("offline");
    attemptsRef.current = 0;
    setTimeout(() => connect(), 50);
  }, [connect, clearTimers]);

  return { ready, lastFrame, send, reconnect, state };
}
