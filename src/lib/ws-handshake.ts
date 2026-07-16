export interface SocketHelloState {
  received: boolean;
}

export interface DuplicateHelloEffects {
  abortBarrier: () => void;
  invalidateGeneration: () => void;
  resetBuffer: () => void;
  close: (code: number, reason: string) => void;
}

/**
 * A WebSocket connection has exactly one authoritative hello. Accepting a
 * second hello would let one transport replace its own sync barrier while
 * retaining frames buffered for the first barrier, so duplicates fail closed.
 */
export function acceptSocketHelloOnce(
  state: SocketHelloState,
  effects: DuplicateHelloEffects,
): boolean {
  if (!state.received) {
    state.received = true;
    return true;
  }

  effects.abortBarrier();
  effects.invalidateGeneration();
  effects.resetBuffer();
  effects.close(1008, "duplicate hello");
  return false;
}
