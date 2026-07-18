type TimelinePanelEvent = {
  sender_kind: string;
  sender_id?: number | null;
  sender_handle?: string | null;
  sender_public_id?: string | null;
  created_at: string;
};

export const TIMELINE_PANEL_ADJACENT_GAP_MS = 60_000;
export const TIMELINE_PANEL_MAX_SPAN_MS = 10 * 60_000;

export function timelineSenderKey(event: TimelinePanelEvent): string {
  const identity = event.sender_public_id || event.sender_handle ||
    (event.sender_id == null ? "unknown" : String(event.sender_id));
  return `${event.sender_kind}:${identity}`;
}

function localDayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/**
 * Consecutive messages share a virtual panel only when they come from the same
 * sender, are at most one minute apart, and the whole run remains under ten
 * minutes. The explicit group-start bound prevents an endless chain of
 * one-minute-apart messages from becoming one giant visual block.
 */
export function belongsToSameTimelinePanel(
  previous: TimelinePanelEvent,
  next: TimelinePanelEvent,
  panelStart: TimelinePanelEvent = previous,
): boolean {
  if (
    timelineSenderKey(previous) !== timelineSenderKey(next) ||
    timelineSenderKey(panelStart) !== timelineSenderKey(next) ||
    localDayKey(previous.created_at) !== localDayKey(next.created_at) ||
    localDayKey(panelStart.created_at) !== localDayKey(next.created_at)
  ) return false;
  const previousAt = Date.parse(previous.created_at);
  const nextAt = Date.parse(next.created_at);
  const panelStartAt = Date.parse(panelStart.created_at);
  if (![previousAt, nextAt, panelStartAt].every(Number.isFinite)) return false;
  const adjacentGap = nextAt - previousAt;
  const panelSpan = nextAt - panelStartAt;
  return adjacentGap >= 0 && adjacentGap <= TIMELINE_PANEL_ADJACENT_GAP_MS &&
    panelSpan >= 0 && panelSpan < TIMELINE_PANEL_MAX_SPAN_MS;
}
