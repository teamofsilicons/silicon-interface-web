type PendingSendControl = {
  controller: AbortController;
  xhrRef: { current: XMLHttpRequest | null };
};

const active = new Map<string, Set<PendingSendControl>>();
const CHANNEL_NAME = "silicon-interface:pending-send-control:v1";
let channel: BroadcastChannel | null | undefined;

function key(ownerId: string, clientId: string): string {
  return `${ownerId}:${clientId}`;
}

function abortLocal(ownerId: string, clientId: string): boolean {
  const controls = active.get(key(ownerId, clientId));
  if (!controls?.size) return false;
  for (const control of controls) {
    control.controller.abort();
    control.xhrRef.current?.abort();
  }
  return true;
}

function controlChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof BroadcastChannel === "undefined") {
    channel = null;
    return channel;
  }
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const value = event.data;
    if (!value || typeof value !== "object") return;
    const ownerId = (value as { ownerId?: unknown }).ownerId;
    const clientId = (value as { clientId?: unknown }).clientId;
    if (typeof ownerId !== "string" || typeof clientId !== "string") return;
    abortLocal(ownerId, clientId);
  };
  return channel;
}

/** Register every abortable transport for one immutable send. Multiple tabs or
 * recovery surfaces may briefly overlap, so cancellation aborts the whole set
 * instead of trusting whichever request registered last. */
export function beginPendingSendControl(ownerId: string, clientId: string): {
  signal: AbortSignal;
  xhrRef: { current: XMLHttpRequest | null };
  finish: () => void;
} {
  const controller = new AbortController();
  controlChannel();
  const control: PendingSendControl = { controller, xhrRef: { current: null } };
  const registryKey = key(ownerId, clientId);
  const controls = active.get(registryKey) ?? new Set<PendingSendControl>();
  controls.add(control);
  active.set(registryKey, controls);
  let finished = false;
  return {
    signal: controller.signal,
    xhrRef: control.xhrRef,
    finish: () => {
      if (finished) return;
      finished = true;
      controls.delete(control);
      if (controls.size === 0) active.delete(registryKey);
    },
  };
}

export function cancelPendingSendControl(ownerId: string, clientId: string): boolean {
  const cancelled = abortLocal(ownerId, clientId);
  controlChannel()?.postMessage({ ownerId, clientId });
  return cancelled;
}
