import type { Event } from "@/lib/types";

type RunAnchoredEvent = Pick<
  Event,
  "event_id" | "sender_kind" | "run_anchor_event_id"
>;

/**
 * Place a silicon response immediately after the carbon turn Glass says
 * triggered it. The relation is deliberately separate from reply_to_event_id:
 * layout grouping must not manufacture a quoted reply or depend on a client
 * guessing which message was current when work began.
 *
 * Unknown, forward, or non-carbon anchors stay in canonical stream order. This
 * makes partial history windows and older servers safe fallbacks.
 */
export function orderRunAnchoredReplies<T extends RunAnchoredEvent>(
  canonical: readonly T[],
): T[] {
  const positionById = new Map<string, number>();
  canonical.forEach((event, index) => {
    if (event.event_id) positionById.set(event.event_id, index);
  });

  const repliesByAnchor = new Map<string, T[]>();
  const movedIds = new Set<string>();
  canonical.forEach((event, index) => {
    const anchorId = event.run_anchor_event_id;
    if (event.sender_kind !== "silicon" || !anchorId) return;
    const anchorIndex = positionById.get(anchorId);
    const anchor = anchorIndex == null ? undefined : canonical[anchorIndex];
    if (
      anchorIndex == null ||
      anchorIndex >= index ||
      anchor?.sender_kind !== "carbon"
    ) {
      return;
    }
    const replies = repliesByAnchor.get(anchorId) ?? [];
    replies.push(event);
    repliesByAnchor.set(anchorId, replies);
    movedIds.add(event.event_id);
  });

  if (movedIds.size === 0) return [...canonical];
  const ordered: T[] = [];
  for (const event of canonical) {
    if (movedIds.has(event.event_id)) continue;
    ordered.push(event);
    ordered.push(...(repliesByAnchor.get(event.event_id) ?? []));
  }
  return ordered;
}
