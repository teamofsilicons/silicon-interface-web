import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const profileSource = await readFile(
  new URL("../../src/components/chat/profile-drawer.tsx", import.meta.url),
  "utf8",
);
const teamSource = await readFile(
  new URL("../../src/components/teams/team-panel.tsx", import.meta.url),
  "utf8",
);

test("profile attachment browser loads the complete room traversal", () => {
  assert.match(profileSource, /loadCompleteRoomHistory\(/);
  assert.match(profileSource, /api\.historyPage\(roomId, cursor, limit, "backward"\)/);
});

test("profile attachments expose the See in Chat context action", () => {
  assert.match(profileSource, /onContextMenu=/);
  assert.match(profileSource, />\s*See in Chat\s*</);
});

test("profile shared content uses Telegram-style category tabs without an All feed", () => {
  const tabs = profileSource.slice(
    profileSource.indexOf("const TABS"),
    profileSource.indexOf("export function ProfileDrawer"),
  );
  assert.doesNotMatch(tabs, /id: "all"/);
  assert.match(tabs, /label: "Media"/);
  assert.match(tabs, /label: "Files"/);
  assert.match(tabs, /label: "Links"/);
  assert.match(tabs, /label: "Voice"/);
  assert.match(tabs, /label: "GIFs"/);
  assert.match(profileSource, /role="tablist"/);
  assert.match(profileSource, /aria-selected=\{tab === t\.id\}/);
  assert.match(profileSource, /overflow-x-auto/);
});

test("profile media separates GIFs and uses container-sized shared previews", () => {
  assert.match(profileSource, /!isGifMedia\(mime, filename\)/);
  assert.match(profileSource, /const gifs = React\.useMemo/);
  assert.match(profileSource, /presentation="profile-media"/);
  assert.match(profileSource, /presentation="profile-file"/);
  assert.match(profileSource, /presentation="profile-voice"/);
});

test("profile links use bounded Telegram-style rows", () => {
  assert.match(profileSource, /divide-y border bg-card/);
  assert.match(profileSource, /line-clamp-2/);
  assert.match(profileSource, /truncate text-xs text-primary/);
});

test("structure frame observes late Quark drawing before declaring failure", () => {
  assert.match(teamSource, /new MutationObserver/);
  assert.match(teamSource, /quark:ready/);
  assert.match(teamSource, /createStructureRenderWatchdog/);
});
