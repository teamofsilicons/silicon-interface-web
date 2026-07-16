export function findVirtualAnchorIndex<T>(
  items: readonly T[],
  eventId: string,
  eventIds: (item: T) => readonly string[],
): number {
  return items.findIndex((item) => eventIds(item).includes(eventId));
}

/** ScrollBy delta that restores an anchor's exact pre-mutation viewport pixel. */
export function anchorPixelCorrection(actualOffset: number, desiredOffset: number): number {
  if (!Number.isFinite(actualOffset) || !Number.isFinite(desiredOffset)) return 0;
  return actualOffset - desiredOffset;
}
