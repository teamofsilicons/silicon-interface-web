/**
 * Count renderable rows that are genuinely new to the caller's projection.
 *
 * A signed server traversal and a durable cache can legitimately overlap.
 * Pagination must scan through that overlap instead of treating cached rows as
 * progress, otherwise the cursor can remain trapped above the visible list.
 */
export function countNovelHistoryRows<T extends { event_id: string }>(
  events: readonly T[],
  knownEventIds: ReadonlySet<string>,
  isRenderable: (event: T) => boolean,
): number {
  let count = 0;
  for (const event of events) {
    if (isRenderable(event) && !knownEventIds.has(event.event_id)) count += 1;
  }
  return count;
}

export function hasNovelHistoryRows<T extends { event_id: string }>(
  events: readonly T[],
  knownEventIds: ReadonlySet<string>,
  isRenderable: (event: T) => boolean,
): boolean {
  return countNovelHistoryRows(events, knownEventIds, isRenderable) > 0;
}
