type SelectionSnapshot = Pick<
  Selection,
  "anchorNode" | "focusNode" | "isCollapsed" | "rangeCount"
>;

type SelectionRoot = Pick<Node, "contains">;

/**
 * Whether a live native Range owns at least one node inside the timeline.
 *
 * Keeping this check independent from React state is intentional: changing
 * the shape of a message list during `selectstart` moves the text underneath
 * the pointer and makes the browser's Range flicker or collapse.
 */
export function selectionTouchesTimeline(
  selection: SelectionSnapshot | null,
  root: SelectionRoot,
): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  return Boolean(
    (selection.anchorNode && root.contains(selection.anchorNode)) ||
      (selection.focusNode && root.contains(selection.focusNode)),
  );
}

export function shouldLoadOlderNearTimelineTop(input: {
  scrollTop: number;
  hasMore: boolean;
  loadingOlder: boolean;
  threshold?: number;
}): boolean {
  return (
    input.scrollTop <= (input.threshold ?? 160) &&
    input.hasMore &&
    !input.loadingOlder
  );
}

/**
 * Whether the viewport is physically at the end of the timeline.
 *
 * Bottom-follow is ownership, not proximity: a reader even a few pixels above
 * the end has taken control of the viewport. The tiny tolerance only absorbs
 * fractional browser scroll metrics and DPI rounding.
 */
export function isTimelineAtBottom(input: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  tolerance?: number;
}): boolean {
  return (
    input.scrollHeight - (input.scrollTop + input.clientHeight) <=
    (input.tolerance ?? 1)
  );
}

/** The page-down affordance is visual, not ownership state. Hide it as soon
 * as the rendered end marker intersects the timeline viewport. Measuring the
 * marker instead of the newest message also covers trailing work/progress rows. */
export function timelineTailIsVisible(input: {
  viewportTop: number;
  viewportBottom: number;
  tailTop: number;
  tailBottom: number;
}): boolean {
  return (
    input.tailBottom > input.viewportTop &&
    input.tailTop < input.viewportBottom
  );
}

/**
 * Scrolling may revoke bottom-follow but may never grant it. Once the reader
 * leaves the end of the timeline, only the explicit page-down action can
 * create a new bottom-follow epoch—even if the reader later scrolls all the
 * way back to the physical bottom by hand.
 */
export function retainBottomFollowAfterScroll(input: {
  followingBottom: boolean;
  atBottom: boolean;
  initialBottomPending?: boolean;
}): boolean {
  return input.followingBottom && (input.initialBottomPending === true || input.atBottom);
}

/**
 * Only an existing bottom-follow epoch may move the viewport after a layout
 * mutation. Tail visibility controls the arrow, never scroll ownership: a
 * partially visible newest message must not pull a reader back to the end.
 */
export function shouldPinOwnedTimelineTail(input: {
  followingBottom: boolean;
  selectionActive: boolean;
}): boolean {
  return input.followingBottom && !input.selectionActive;
}

/** User input is authoritative before the browser emits its later `scroll`
 * event. Revoking follow on the intent phase closes the wheel/resize race that
 * can otherwise snap a conversation back to the end before the first upward
 * scroll delta lands. */
export function wheelMovesTowardTimelineHistory(deltaY: number): boolean {
  return deltaY < 0;
}

/** A downward finger movement moves a normal vertical scroll surface toward
 * older content. Ignore sub-pixel jitter from stationary touches. */
export function touchMovesTowardTimelineHistory(
  previousClientY: number,
  currentClientY: number,
  tolerance = 1,
): boolean {
  return currentClientY - previousClientY > tolerance;
}

export function keyMovesTowardTimelineHistory(key: string, shiftKey = false): boolean {
  return (
    key === "ArrowUp" ||
    key === "PageUp" ||
    key === "Home" ||
    (key === " " && shiftKey)
  );
}

/**
 * A scheduled bottom correction may run only while the same ownership epoch
 * still belongs to bottom-follow. Manual wheel, touch, pointer, keyboard, or
 * selection input advances the epoch synchronously, invalidating every frame
 * that was queued before that interaction.
 */
export function canApplyScheduledBottomScroll(input: {
  scheduledEpoch: number;
  currentEpoch: number;
  followingBottom: boolean;
  selectionActive: boolean;
}): boolean {
  return (
    input.scheduledEpoch === input.currentEpoch &&
    input.followingBottom &&
    !input.selectionActive
  );
}
