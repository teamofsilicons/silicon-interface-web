type TimelinePanelEvent = {
  sender_kind: string;
  sender_id?: number | null;
  sender_handle?: string | null;
  sender_public_id?: string | null;
  created_at: string;
};

export function timelineSenderKey(event: TimelinePanelEvent): string {
  const identity = event.sender_public_id || event.sender_handle ||
    (event.sender_id == null ? "unknown" : String(event.sender_id));
  return `${event.sender_kind}:${identity}`;
}

function localDayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** Consecutive messages share a virtual panel only for the same sender/day. */
export function belongsToSameTimelinePanel(
  previous: TimelinePanelEvent,
  next: TimelinePanelEvent,
): boolean {
  return timelineSenderKey(previous) === timelineSenderKey(next) &&
    localDayKey(previous.created_at) === localDayKey(next.created_at);
}
