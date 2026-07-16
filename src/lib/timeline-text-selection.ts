export type TimelineViewportPadding = { top: number; bottom: number };

const IDLE_VIEWPORT: TimelineViewportPadding = { top: 900, bottom: 700 };
const SELECTING_VIEWPORT: TimelineViewportPadding = {
  // Effectively retain the complete loaded window while a native Range owns
  // nodes inside it. The server history is still paged, so this does not fetch
  // or render unbounded history outside the already-loaded client window.
  top: 1_000_000,
  bottom: 1_000_000,
};

export function timelineViewportPadding(selectionActive: boolean): TimelineViewportPadding {
  return selectionActive ? SELECTING_VIEWPORT : IDLE_VIEWPORT;
}

export function shouldLoadOlderDuringRangeChange(input: {
  selectionActive: boolean;
  startIndex: number;
  hasMore: boolean;
  loadingOlder: boolean;
}): boolean {
  return !input.selectionActive && input.startIndex <= 4 && input.hasMore && !input.loadingOlder;
}
