export type StructureRenderResult = "ready" | "error";

export interface StructureRenderTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** One-shot renderer gate. Once the chart reports success, neither its old
 * timeout nor a later error can revoke that successful render. */
export function createStructureRenderWatchdog(
  onSettled: (result: StructureRenderResult) => void,
  timeoutMs = 30_000,
  timers?: StructureRenderTimers,
): {
  ready: () => void;
  error: () => void;
  dispose: () => void;
} {
  const schedule = timers?.setTimeout ?? ((callback: () => void, delayMs: number) =>
    globalThis.setTimeout(callback, delayMs));
  const cancel = timers?.clearTimeout ?? ((handle: unknown) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  let settled = false;

  const settle = (result: StructureRenderResult) => {
    if (settled) return;
    settled = true;
    if (timeoutHandle !== undefined) cancel(timeoutHandle);
    onSettled(result);
  };

  const timeoutHandle = schedule(() => settle("error"), timeoutMs);

  return {
    ready: () => settle("ready"),
    error: () => settle("error"),
    dispose: () => {
      if (settled) return;
      settled = true;
      if (timeoutHandle !== undefined) cancel(timeoutHandle);
    },
  };
}
