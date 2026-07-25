import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canApplyScheduledBottomScroll,
  isTimelineAtBottom,
  keyMovesTowardTimelineHistory,
  retainBottomFollowAfterScroll,
  selectionTouchesTimeline,
  shouldPinOwnedTimelineTail,
  shouldLoadOlderNearTimelineTop,
  timelineTailMessageIsVisible,
  touchMovesTowardTimelineHistory,
  wheelMovesTowardTimelineHistory,
} from "../../src/lib/timeline-text-selection.ts";

const markdownViewSource = await readFile(
  new URL("../../src/components/chat/markdown-view.tsx", import.meta.url),
  "utf8",
);
const roomViewSource = await readFile(
  new URL("../../src/components/chat/room-view.tsx", import.meta.url),
  "utf8",
);
const chatPageSource = await readFile(
  new URL("../../src/app/chat/page.tsx", import.meta.url),
  "utf8",
);
const messageBubbleSource = await readFile(
  new URL("../../src/components/chat/message-bubble.tsx", import.meta.url),
  "utf8",
);
const linkPreviewCardSource = await readFile(
  new URL("../../src/components/chat/link-preview-card.tsx", import.meta.url),
  "utf8",
);
const globalCssSource = await readFile(
  new URL("../../src/app/globals.css", import.meta.url),
  "utf8",
);

test("timeline selection recognizes either endpoint without changing list layout", () => {
  const timelineNode = {};
  const outsideNode = {};
  const root = { contains: (node) => node === timelineNode };

  assert.equal(selectionTouchesTimeline({
    anchorNode: timelineNode,
    focusNode: outsideNode,
    isCollapsed: false,
    rangeCount: 1,
  }, root), true);
  assert.equal(selectionTouchesTimeline({
    anchorNode: outsideNode,
    focusNode: timelineNode,
    isCollapsed: false,
    rangeCount: 1,
  }, root), true);
  assert.equal(selectionTouchesTimeline({
    anchorNode: timelineNode,
    focusNode: timelineNode,
    isCollapsed: true,
    rangeCount: 1,
  }, root), false);
});

test("a persistent selection never blocks older-history pagination", () => {
  assert.equal(shouldLoadOlderNearTimelineTop({
    scrollTop: 0,
    hasMore: true,
    loadingOlder: false,
  }), true);
  assert.equal(shouldLoadOlderNearTimelineTop({
    scrollTop: 100,
    hasMore: true,
    loadingOlder: false,
  }), true);
  assert.equal(shouldLoadOlderNearTimelineTop({
    scrollTop: 161,
    hasMore: true,
    loadingOlder: false,
  }), false);
});

test("markdown rerenders reuse component types so browser Ranges keep their nodes", () => {
  assert.match(markdownViewSource, /const MARKDOWN_COMPONENTS: Components = \{/);
  assert.match(markdownViewSource, /components=\{MARKDOWN_COMPONENTS\}/);
  assert.doesNotMatch(markdownViewSource, /components=\{\{/);
});

test("bottom-follow requires the physical end, not a near-bottom reading position", () => {
  assert.equal(isTimelineAtBottom({
    scrollHeight: 1_000,
    scrollTop: 499,
    clientHeight: 500,
  }), true);
  assert.equal(isTimelineAtBottom({
    scrollHeight: 1_000,
    scrollTop: 498,
    clientHeight: 500,
  }), false);
  assert.equal(isTimelineAtBottom({
    scrollHeight: 1_000,
    scrollTop: 380,
    clientHeight: 500,
  }), false);
});

test("the down arrow hides when even one pixel of the newest message is visible", () => {
  assert.equal(timelineTailMessageIsVisible({
    viewportTop: 100,
    viewportBottom: 600,
    messageTop: 599,
    messageBottom: 720,
  }), true);
  assert.equal(timelineTailMessageIsVisible({
    viewportTop: 100,
    viewportBottom: 600,
    messageTop: 600,
    messageBottom: 720,
  }), false);
  assert.equal(timelineTailMessageIsVisible({
    viewportTop: 100,
    viewportBottom: 600,
    messageTop: 50,
    messageBottom: 101,
  }), true);
  assert.match(roomViewSource, /renderedEventIdFor\(lastTimelineEventId\)/);
});

test("arrow-acquired bottom follow survives until an explicit upward gesture", () => {
  const pointerIntent = roomViewSource.slice(
    roomViewSource.indexOf("onPointerDownCapture"),
    roomViewSource.indexOf("onWheelCapture"),
  );
  assert.doesNotMatch(pointerIntent, /releaseBottomStick\(\)/);
  assert.match(roomViewSource, /scroller\.scrollTop < scrollbarGesture\.lastScrollTop - 1/);
  assert.match(roomViewSource, /wheelMovesTowardTimelineHistory\(event\.deltaY\)/);
  assert.match(roomViewSource, /touchMovesTowardTimelineHistory\(previousY, currentY\)/);
  assert.match(roomViewSource, /keyMovesTowardTimelineHistory\(event\.key, event\.shiftKey\)/);
});

test("manual interaction invalidates every already-scheduled bottom correction", () => {
  assert.equal(canApplyScheduledBottomScroll({
    scheduledEpoch: 4,
    currentEpoch: 5,
    followingBottom: false,
    selectionActive: false,
  }), false);
  assert.equal(canApplyScheduledBottomScroll({
    scheduledEpoch: 5,
    currentEpoch: 5,
    followingBottom: true,
    selectionActive: true,
  }), false);
  assert.equal(canApplyScheduledBottomScroll({
    scheduledEpoch: 5,
    currentEpoch: 5,
    followingBottom: true,
    selectionActive: false,
  }), true);
});

test("physical bottom can never silently re-enable reader-revoked follow mode", () => {
  assert.equal(retainBottomFollowAfterScroll({
    followingBottom: false,
    atBottom: true,
  }), false);
  assert.equal(retainBottomFollowAfterScroll({
    followingBottom: true,
    atBottom: false,
  }), false);
  assert.equal(retainBottomFollowAfterScroll({
    followingBottom: true,
    atBottom: true,
  }), true);
  assert.equal(retainBottomFollowAfterScroll({
    followingBottom: true,
    atBottom: false,
    initialBottomPending: true,
  }), true, "passive initial layout scrolls cannot strand a reload mid-history");
});

test("reader scroll never grants follow and a hidden arrow never owns scrolling", () => {
  assert.match(roomViewSource, /onPointerDownCapture=\{\(event\) => \{/);
  assert.match(roomViewSource, /onWheelCapture=\{\(event\) => \{/);
  assert.match(roomViewSource, /wheelMovesTowardTimelineHistory\(event\.deltaY\)/);
  assert.match(roomViewSource, /touchMovesTowardTimelineHistory\(previousY, currentY\)/);
  assert.match(roomViewSource, /keyMovesTowardTimelineHistory\(event\.key, event\.shiftKey\)/);
  assert.doesNotMatch(roomViewSource, /stickToBottomRef\.current = atBottom/);
  assert.equal(
    roomViewSource.match(/activateBottomFollowFromArrow\(\)/g)?.length,
    1,
  );
  assert.match(roomViewSource, /keepOwnedBottomPinned/);
  assert.match(roomViewSource, /overflow-anchor:none/);
  assert.match(roomViewSource, /canApplyScheduledBottomScroll/);
  assert.doesNotMatch(roomViewSource, /behavior: "smooth"/);
  assert.doesNotMatch(roomViewSource, /clientHeight <= 120/);
});

test("passive layout scrolls cannot revoke an owned bottom-follow epoch", () => {
  const passiveScrollState = roomViewSource.slice(
    roomViewSource.indexOf("const updateTimelineBottomState"),
    roomViewSource.indexOf("const openSenderProfile"),
  );
  assert.doesNotMatch(passiveScrollState, /releaseBottomStick/);
  assert.doesNotMatch(passiveScrollState, /retainBottomFollowAfterScroll/);
  assert.match(passiveScrollState, /newestMessageIsVisible/);
});

test("link previews reserve their exact final card height before metadata arrives", () => {
  assert.match(linkPreviewCardSource, /className="[^"]*h-20[^"]*overflow-hidden/);
  assert.match(linkPreviewCardSource, /export function fallbackLinkPreview/);
  assert.match(messageBubbleSource, /const stableLinkPreview = event\.link_preview \?\?/);
  assert.match(messageBubbleSource, /bodyUrls\.length === 1 \? fallbackLinkPreview/);
  assert.equal(
    messageBubbleSource.match(/<LinkPreviewCard preview=\{stableLinkPreview\}/g)?.length,
    2,
  );
});

test("layout changes pin only an already-owned bottom-follow epoch", () => {
  assert.equal(shouldPinOwnedTimelineTail({
    followingBottom: false,
    selectionActive: false,
  }), false);
  assert.equal(shouldPinOwnedTimelineTail({
    followingBottom: false,
    selectionActive: false,
  }), false, "tail visibility cannot reacquire scroll ownership");
  assert.equal(shouldPinOwnedTimelineTail({
    followingBottom: true,
    selectionActive: true,
  }), false);
  assert.equal(shouldPinOwnedTimelineTail({
    followingBottom: true,
    selectionActive: false,
  }), true);
});

test("older-history prepends keep one event at the same pixel through late layout", () => {
  assert.match(roomViewSource, /historyViewportAnchorRef/);
  assert.match(roomViewSource, /const captureHistoryViewportAnchor = React\.useCallback/);
  assert.match(roomViewSource, /preserveHistoryViewportAnchor\(\)/);
  assert.match(roomViewSource, /anchor\.scrollTop \+ \(scroller\.scrollHeight - anchor\.scrollHeight\)/);
  assert.match(roomViewSource, /if \(preserveHistoryViewportAnchor\(\)\) \{/);
  assert.match(roomViewSource, /if \(preserveHistoryViewportAnchor\(true\)\) return/);
  assert.match(roomViewSource, /awaitingCommit: true/);
  assert.match(
    roomViewSource,
    /if \(!force && historyViewportAnchorRef\.current\?\.awaitingCommit\) return/,
  );
  assert.match(roomViewSource, /if \(committed\) anchor\.awaitingCommit = false/);
  assert.match(roomViewSource, /flushSync\(\(\) => \{/);
  assert.match(roomViewSource, /preserveHistoryViewportAnchor\(true\);\n\s+reportHistoryHealthy/);
  assert.match(roomViewSource, /clearHistoryViewportAnchor\(true\);\n\s+\/\/ A wheel gesture/);
  assert.doesNotMatch(roomViewSource, /pendingPrependRef/);
  assert.match(roomViewSource, />\s*Loading older messages…\s*</);
});

test("late initial cache hydration uses the same guarded prepend as later pages", () => {
  assert.match(roomViewSource, /const commitInitialTimelineRows = async/);
  assert.doesNotMatch(roomViewSource, /waitForTextSelectionEnd|selectionEndWaitersRef/);
  assert.match(roomViewSource, /await waitForOlderHistoryIndicatorPaint\(\)/);
  assert.match(roomViewSource, /captureHistoryViewportAnchor\(incoming\)/);
  assert.match(roomViewSource, /if \(protectReaderPosition\) preserveHistoryViewportAnchor\(true\)/);
  assert.match(roomViewSource, /await commitInitialTimelineRows\(stored\)/);
  assert.doesNotMatch(roomViewSource, /await durableCachePromise/);
});

test("history pages become durable before the recipient acknowledges delivery", () => {
  assert.match(roomViewSource, /const persistHistoryEvents = React\.useCallback/);
  assert.match(roomViewSource, /await storeEvents\(/);
  assert.match(roomViewSource, /onHistoryStored\?\.\(\)/);
  assert.match(roomViewSource, /void persistHistoryEvents\(finalized\)/);
  assert.match(roomViewSource, /void persistHistoryEvents\(older\)/);
  assert.match(chatPageSource, /onHistoryStored=\{acknowledgeStoredRoomHistory\}/);
});

test("older-history loading overlays the viewport and survives at least one visible paint", () => {
  assert.match(roomViewSource, /pointer-events-none absolute left-1\/2 top-3/);
  assert.doesNotMatch(roomViewSource, /function ChatListHeader/);
  assert.match(roomViewSource, /const OLDER_LOADING_MIN_MS = 180/);
  assert.match(roomViewSource, /await waitForOlderHistoryIndicatorPaint\(\)/);
  assert.match(roomViewSource, /window\.requestAnimationFrame\(\(\) => \{\n\s+window\.requestAnimationFrame\(finish\)/);
  assert.match(roomViewSource, /OLDER_LOADING_MIN_MS - \(performance\.now\(\) - indicatorVisibleAt\)/);
});

test("an explicit user scroll back to the physical tail renews bottom follow", () => {
  assert.match(roomViewSource, /const returningToBottomRef = React\.useRef\(false\)/);
  assert.match(roomViewSource, /returningToBottomRef\.current = event\.deltaY > 0/);
  assert.match(roomViewSource, /if \(returningToBottomRef\.current\) acquireBottomFollowAtCurrentTail\(\)/);
  assert.match(roomViewSource, /acquireBottomFollowAtCurrentTail\(\);\n\s+keepOwnedBottomPinned\(\)/);
  assert.match(roomViewSource, /isTimelineAtBottom\(\{/);
});

test("the explicit down arrow uses a short custom flight while auto-follow stays instant", () => {
  const arrowActivation = roomViewSource.slice(
    roomViewSource.indexOf("const activateBottomFollowFromArrow"),
    roomViewSource.indexOf("const keepOwnedBottomPinned"),
  );
  const animation = roomViewSource.slice(
    roomViewSource.indexOf("const animateToBottom"),
    roomViewSource.indexOf("const scheduleBottomScroll"),
  );
  assert.match(roomViewSource, /const PAGE_DOWN_ANIMATION_MS = 180/);
  assert.match(arrowActivation, /animateToBottom\(\)/);
  assert.doesNotMatch(arrowActivation, /scheduleBottomScroll\(\)/);
  assert.match(animation, /window\.requestAnimationFrame\(step\)/);
  assert.match(animation, /1 - Math\.pow\(1 - progress, 3\)/);
  assert.match(animation, /prefers-reduced-motion: reduce/);
  assert.match(roomViewSource, /scroller\.scrollTop = scroller\.scrollHeight/);
  assert.doesNotMatch(roomViewSource, /behavior: "smooth"/);
});

test("transport and device updates cannot reopen history or reclaim scrolling", () => {
  const initialLoader = roomViewSource.slice(
    roomViewSource.indexOf("// ----- Initial events load -----"),
    roomViewSource.indexOf("// The page-level worker owns retries"),
  );
  assert.match(roomViewSource, /socketStateRef\.current = socketState/);
  assert.match(
    roomViewSource,
    /const reportHistoryFailure = React\.useCallback[\s\S]+?\}, \[carbon\?\.carbon_id, room\.room_id\]\);/,
  );
  assert.match(initialLoader, /const roomOpenTimelineDevice = timelineDeviceRef\.current/);
  assert.doesNotMatch(initialLoader, /^\s+socketState,\s*$/m);
  assert.doesNotMatch(initialLoader, /^\s+timelineDevice,\s*$/m);
});

test("reader input revokes follow during intent, before the browser scroll event", () => {
  assert.equal(wheelMovesTowardTimelineHistory(-1), true);
  assert.equal(wheelMovesTowardTimelineHistory(1), false);
  assert.equal(touchMovesTowardTimelineHistory(100, 102), true);
  assert.equal(touchMovesTowardTimelineHistory(100, 100.5), false);
  assert.equal(keyMovesTowardTimelineHistory("ArrowUp"), true);
  assert.equal(keyMovesTowardTimelineHistory("PageUp"), true);
  assert.equal(keyMovesTowardTimelineHistory("Home"), true);
  assert.equal(keyMovesTowardTimelineHistory(" ", true), true);
  assert.equal(keyMovesTowardTimelineHistory("ArrowDown"), false);
  assert.equal(keyMovesTowardTimelineHistory(" ", false), false);
});

test("manual scrolling cancels every competing scroll writer immediately", () => {
  const release = roomViewSource.slice(
    roomViewSource.indexOf("const releaseBottomStick"),
    roomViewSource.indexOf("const scrollToBottom"),
  );
  assert.match(release, /clearHistoryViewportAnchor\(true\)/);
  assert.match(release, /cancelPendingBottomScroll\(\)/);
  assert.match(release, /cancelBottomAnimation\(\)/);

  const wheel = roomViewSource.slice(
    roomViewSource.indexOf("onWheelCapture"),
    roomViewSource.indexOf("onTouchStartCapture"),
  );
  assert.match(wheel, /cancelBottomAnimation\(\)/);
  assert.match(wheel, /cancelPendingBottomScroll\(\)/);
});

test("sync generations keep the open conversation surface and native Range mounted", () => {
  assert.match(chatPageSource, /key=\{selectedRoom\.room_id\}/);
  assert.doesNotMatch(chatPageSource, /projectionGeneration/);
  assert.doesNotMatch(roomViewSource, /selectionEventSnapshot|setSelectionEventSnapshot/);
  assert.match(roomViewSource, /const renderedEvents = events/);
  assert.doesNotMatch(roomViewSource, /deferredEventProjectionRef/);
});

test("double-click selection never schedules a timeline render", () => {
  const selectionOwnership = roomViewSource.slice(
    roomViewSource.indexOf("const updateTextSelectionActive"),
    roomViewSource.indexOf("// Tracks whether the user is parked at the bottom"),
  );
  assert.doesNotMatch(
    selectionOwnership,
    /setSelectionEventSnapshot|setEvents|setTimelineAtBottom|setUnseenBelow/,
  );
  assert.match(selectionOwnership, /textSelectionActiveRef\.current = active/);
});

test("page-down clears a persistent selection and always takes bottom ownership", () => {
  const arrowActivation = roomViewSource.slice(
    roomViewSource.indexOf("const activateBottomFollowFromArrow"),
    roomViewSource.indexOf("const acquireBottomFollowAtCurrentTail"),
  );
  assert.match(arrowActivation, /clearTimelineTextSelection\(\)/);
  assert.match(arrowActivation, /stickToBottomRef\.current = true/);
  assert.match(arrowActivation, /animateToBottom\(\)/);
  assert.doesNotMatch(arrowActivation, /textSelectionActiveRef\.current\) return/);
});

test("loaded chat rows stay mounted so scrolling and clicks cannot recycle the viewport", () => {
  assert.doesNotMatch(roomViewSource, /useVirtualizer|timelineVirtualizer|virtualTimelineItems/);
  assert.match(roomViewSource, /\{timelineItems\.map\(\(item\) => \(/);
});

test("an ordinary chat click does not promote the timeline into selection mode", () => {
  const selectStart = roomViewSource.slice(
    roomViewSource.indexOf("const onSelectStart"),
    roomViewSource.indexOf("const onSelectionChange"),
  );
  assert.match(selectStart, /selectionGestureRef\.current = true/);
  assert.doesNotMatch(selectStart, /releaseBottomStick/);
  assert.doesNotMatch(selectStart, /updateTextSelectionActive\(true\)/);

  const selectionChange = roomViewSource.slice(
    roomViewSource.indexOf("const onSelectionChange"),
    roomViewSource.indexOf("const onPointerEnd"),
  );
  assert.match(selectionChange, /const selectionActive = hasTimelineSelection\(\)/);
  assert.match(selectionChange, /releaseBottomStick\(\)/);
  assert.match(selectionChange, /if \(selectionActive\) updateTextSelectionActive\(true\)/);
});

test("opening a room clears unread state before navigation or timeline hydration", () => {
  assert.match(
    chatPageSource,
    /onSelect=\{\(id\) => \{\s+markRoomReadImmediately\(id\);\s+navigate/,
  );
  assert.match(
    chatPageSource,
    /React\.useLayoutEffect\(\(\) => \{[\s\S]+?markRoomReadImmediately\(selected\)/,
  );
  assert.match(chatPageSource, /markRoomReadImmediately\(selected, normalized\)/);
  const roomDetailStart = chatPageSource.indexOf("api\n      .roomDetail(selected)");
  const roomDetailEnd = chatPageSource.indexOf("// Load this user's personal folder store");
  assert.ok(roomDetailStart >= 0 && roomDetailEnd > roomDetailStart);
  const roomDetailRead = chatPageSource.slice(roomDetailStart, roomDetailEnd);
  assert.doesNotMatch(roomDetailRead, /readOpenedSelectionRef\.current !== selected/);
  const visibleReadStart = roomViewSource.indexOf("const markVisibleRead = React.useCallback");
  const visibleReadEnd = roomViewSource.indexOf("// ----- Take-back / self-delete");
  assert.ok(visibleReadStart >= 0 && visibleReadEnd > visibleReadStart);
  const visibleRead = roomViewSource.slice(visibleReadStart, visibleReadEnd);
  assert.doesNotMatch(visibleRead, /!hydrated/);
  assert.doesNotMatch(roomViewSource, /roomOpenReadTarget/);
});

test("committing a send clears the open room's known unread tail before optimistic paint", () => {
  assert.match(
    chatPageSource,
    /onSendIntent=\{\(\) => markRoomReadImmediately\(selectedRoom\.room_id\)\}/,
  );
  const optimisticAdd = roomViewSource.slice(
    roomViewSource.indexOf("const onOptimisticAdd"),
    roomViewSource.indexOf("const onAck", roomViewSource.indexOf("const onOptimisticAdd")),
  );
  assert.ok(optimisticAdd.indexOf("onSendIntent?.()") >= 0);
  assert.ok(
    optimisticAdd.indexOf("onSendIntent?.()") <
      optimisticAdd.indexOf("appendRoomEventSnippet"),
  );
});

test("background room refresh failures stay in quiet recovery instead of toast churn", () => {
  assert.doesNotMatch(chatPageSource, /Your messages are still safe — try again\./);
  assert.match(chatPageSource, /reportSyncRecovery\(ownerId/);
});

test("accepted sends and exact-event receipts synchronize the sidebar and timeline", () => {
  assert.match(chatPageSource, /onEventAccepted=\{\(event\) => projectAcceptedRoomEvent/);
  assert.match(roomViewSource, /onEventAccepted\?\.\(accepted\)/);
  assert.match(roomViewSource, /onEventAccepted\?\.\(optimistic\)/);
  assert.match(roomViewSource, /onEventAccepted\?\.\(real\)/);
  assert.match(roomViewSource, /room\.last_event\?\.event_id === e\.event_id/);
  assert.match(roomViewSource, /bestStatus\(e\._status, e\.delivery\?\.state\)/);
  assert.match(roomViewSource, /markPendingPreviewAccepted\(room\.room_id, clientId\)/);
  assert.match(roomViewSource, /_failure: accepted \? undefined : existing\._failure/);
  assert.match(roomViewSource, /readTimelineIdentity\(timelineOwner, clientId\)\?\.eventId/);
  assert.match(messageBubbleSource, /const actionableFailure =/);
  assert.match(messageBubbleSource, /action !== "repair_session"/);
});

test("message selection flow captures the entire row for select and deselect", () => {
  assert.match(messageBubbleSource, /onClickCapture=\{inSelect/);
  assert.match(messageBubbleSource, /clickEvent\.preventDefault\(\)/);
  assert.match(messageBubbleSource, /clickEvent\.stopPropagation\(\)/);
  assert.match(messageBubbleSource, /onToggleSelect\?\.\(event\)/);
  assert.doesNotMatch(messageBubbleSource, /onClick=\{inSelect/);
  assert.doesNotMatch(
    globalCssSource,
    /data-timeline-selection-active[^}]+timeline-page-down[^}]+opacity:\s*0/is,
    "native text selection must never hide the explicit page-down control",
  );
});
