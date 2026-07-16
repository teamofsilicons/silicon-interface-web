export type BarrierOffer = "passthrough" | "buffered" | "ignored" | "overflow";

/** Bounded history/live handoff queue. A failed barrier never leaks stale frames. */
export class SyncBarrierBuffer<T> {
  private active = false;
  private items: T[] = [];

  constructor(private readonly capacity = 1_000) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("invalid barrier capacity");
  }

  start(): void {
    this.active = true;
    this.items = [];
  }

  offer(item: T, control = false): BarrierOffer {
    if (!this.active) return "passthrough";
    if (control) return "ignored";
    if (this.items.length >= this.capacity) return "overflow";
    this.items.push(item);
    return "buffered";
  }

  release(): T[] {
    if (!this.active) return [];
    const released = this.items;
    this.items = [];
    this.active = false;
    return released;
  }

  reset(): void {
    this.active = false;
    this.items = [];
  }
}
