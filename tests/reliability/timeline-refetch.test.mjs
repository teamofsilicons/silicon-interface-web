import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const roomViewSource = await readFile(
  new URL("../../src/components/chat/room-view.tsx", import.meta.url),
  "utf8",
);
const chatPageSource = await readFile(
  new URL("../../src/app/chat/page.tsx", import.meta.url),
  "utf8",
);

test("the reconnect catch-up defaults to pulling, and skips only a proven duplicate", () => {
  const edge = roomViewSource.indexOf("const firstEdgeForThisRoom");
  assert.ok(edge > 0);
  const branch = roomViewSource.slice(edge, edge + 1200);

  // Skipping requires BOTH that this is the first ready edge for this room open
  // and that the initial window for this same room actually landed.
  assert.match(branch, /firstEdgeForThisRoom && initial\?\.roomId === room\.room_id/);
  // Everything else pulls. Missing frames after a drop is far worse than one
  // extra request, so every uncertain path resolves toward the network.
  assert.match(branch, /\} else \{\s*pull\(\);/);
  assert.match(branch, /if \(!loaded\) pull\(\);/);
  assert.match(branch, /\.catch\(\(\) => pull\(\)\)/);
});

test("a genuine reconnect always re-pulls the open room", () => {
  // The edge marker flips to true as soon as one edge is seen, so the second
  // and every later ready edge is a reconnect and takes the pull path.
  const edge = roomViewSource.indexOf("const firstEdgeForThisRoom");
  const marker = roomViewSource.indexOf("sawSocketReadyForRoomRef.current = true;", edge);
  assert.ok(marker > edge && marker - edge < 300);
});

test("a socket already live at room open leaves its next edge a reconnect", () => {
  // Opening a room on a live socket misses nothing, so nothing is skipped; but
  // a later drop and return must still re-pull.
  assert.match(
    roomViewSource,
    /sawSocketReadyForRoomRef\.current = socketReadyRef\.current;/,
  );
  // The room-open effect must not depend on socketReady itself — that would
  // reopen the room on every connect and discard the reader's scroll position.
  assert.match(roomViewSource, /const socketReadyRef = React\.useRef\(socketReady\)/);
});

test("the room-open window load still runs unconditionally", () => {
  // The durable cache paints first, but the authoritative window is what
  // reconciles receipts, is_final, and redactions. It is never skipped.
  const initial = roomViewSource.indexOf("const initialWindow = loadTimelineWindow(roomId)");
  assert.ok(initial > 0);
  const preceding = roomViewSource.slice(initial - 400, initial);
  assert.doesNotMatch(preceding, /if \(.*\)\s*$/);
  assert.match(roomViewSource, /setHydrated\(true\); \/\/ §2\.5/);
});

test("only an authoritative room refresh arms the sidebar cache writer", () => {
  const refresh = chatPageSource.indexOf("const refresh = React.useCallback");
  assert.ok(refresh > 0);
  const body = chatPageSource.slice(refresh, refresh + 1600);

  const success = body.indexOf("await refreshRoomsAuthoritatively();");
  const armed = body.indexOf("roomsCacheReadyRef.current = true;");
  const settled = body.indexOf("} finally {");
  assert.ok(success > 0 && armed > success && armed < settled);

  // The loading flags must still settle on every path, or a failed refresh
  // leaves the shell spinning over a perfectly readable cache.
  const tail = body.slice(settled);
  assert.match(tail, /setLoading\(false\);/);
  assert.match(tail, /setRefreshing\(false\);/);
  assert.doesNotMatch(tail, /roomsCacheReadyRef\.current = true;/);
});
