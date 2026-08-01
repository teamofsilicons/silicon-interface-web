import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [roomList, roomView, profileDrawer] = await Promise.all([
  readFile(new URL("../../src/components/chat/room-list.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/room-view.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/profile-drawer.tsx", import.meta.url), "utf8"),
]);

test("a group sidebar preview identifies the signed-in sender as you", () => {
  assert.match(roomList, /const groupSenderLabel =[\s\S]*?mineLast[\s\S]*?\? "you"/);
  assert.match(roomList, /senderLabel=\{groupSenderLabel\}/);
});

test("a group sidebar preview names another sender using saved contacts first", () => {
  assert.match(roomList, /const lastSenderContact =[\s\S]*?contacts\?\.get/);
  assert.match(
    roomList,
    /lastSenderContact\?\.name\?\.trim\(\) \|\|[\s\S]*?lastSenderPeer\?\.name\?\.trim\(\) \|\|/,
  );
  assert.match(roomList, /\{senderLabel\}:<\/span>/);
});

test("opening a group header renders the complete projected member list", () => {
  assert.match(profileDrawer, /const showingGroupOverview = room\.kind === "group" && !focusSender/);
  assert.match(profileDrawer, /for \(const peer of room\.peers\) add\(groupProfileMemberFromPeer\(peer\)\)/);
  assert.match(roomView, /currentCarbon=\{carbon\}/);
  assert.match(profileDrawer, /<GroupOverview[\s\S]*members=\{groupMembers\}/);
});
