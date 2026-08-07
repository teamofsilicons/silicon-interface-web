import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatPageSource = await readFile(
  new URL("../../src/app/chat/page.tsx", import.meta.url),
  "utf8",
);
const roomViewSource = await readFile(
  new URL("../../src/components/chat/room-view.tsx", import.meta.url),
  "utf8",
);

test("accepted socket events always enter the room handoff cache", () => {
  const eventHandler = chatPageSource.indexOf('if (f.type === "event")');
  const handoff = chatPageSource.indexOf("appendRoomEventSnippet(rid, ev);", eventHandler);
  const roomLookup = chatPageSource.indexOf("const room = roomsRef.current.find", eventHandler);

  assert.ok(eventHandler >= 0 && handoff > eventHandler && roomLookup > handoff);
  assert.doesNotMatch(
    chatPageSource,
    /if \(!isOpen\) appendRoomEventSnippet\(rid, ev\);/,
  );
});

test("the mounted room receives live frames before sidebar projection work", () => {
  const dispatch = chatPageSource.indexOf("const dispatchFrame = React.useCallback");
  const fanout = chatPageSource.indexOf("for (const fn of frameListenersRef.current)", dispatch);
  const pageProjection = chatPageSource.indexOf("pageFrameRef.current(f, opts);", dispatch);

  assert.ok(dispatch >= 0 && fanout > dispatch && pageProjection > fanout);
});

test("live socket frames render before browser durability work", () => {
  const handler = chatPageSource.indexOf("const onLiveFrame = React.useCallback");
  const dispatch = chatPageSource.indexOf("dispatchFrame(frame);", handler);
  const persist = chatPageSource.indexOf("await storeEvents(owner", handler);

  assert.ok(handler >= 0 && dispatch > handler && persist > dispatch);
});

test("an opening room closes the listener mount gap from the handoff cache", () => {
  const comment = roomViewSource.indexOf(
    "Install the listener before rereading the page-owned handoff cache",
  );
  const subscribe = roomViewSource.indexOf("const unsubscribe = socketSubscribe", comment);
  const handoff = roomViewSource.indexOf("readRoomEventSnippet(room.room_id)", subscribe);
  const merge = roomViewSource.indexOf("mergeServerEvents(", handoff);

  assert.ok(comment >= 0 && subscribe > comment && handoff > subscribe && merge > handoff);
});

test("a cold snapshot projects durable recovered messages into an already-open room", () => {
  const snapshot = chatPageSource.indexOf("const runInitialSnapshot = React.useCallback");
  const committed = chatPageSource.indexOf("await commitInitialSyncBundle", snapshot);
  const projected = chatPageSource.indexOf(
    "for (const frame of snapshotFrames) dispatchFrame(frame, { quiet: true });",
    committed,
  );
  const hydrated = chatPageSource.indexOf(
    "await hydrateInitialSyncBundle(owner, { authoritativeDraftAbsence: true });",
    committed,
  );

  assert.ok(snapshot >= 0 && committed > snapshot && projected > committed && hydrated > projected);
});
