import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [lordsPage, lordsLayout, roomList, observedTimeline, teamPanel] = await Promise.all([
  readFile(new URL("../../src/app/lords/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/app/lords/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/components/chat/room-list.tsx", import.meta.url), "utf8"),
  readFile(
    new URL("../../src/components/chat/observed-chat-timeline.tsx", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../../src/components/teams/team-panel.tsx", import.meta.url), "utf8"),
]);

test("Lords uses the normal Interface application shell", () => {
  assert.match(lordsLayout, /<AppHeader active="chat" \/>/);
  assert.match(lordsLayout, /<ChatConnectionProvider>/);
  assert.match(lordsLayout, /<TimezoneSync \/>/);
});

test("Lords partitions standard conversation rows by message history", () => {
  assert.match(
    lordsPage,
    /conversationRooms = filteredRooms\.filter\(\(candidate\) => candidate\.last_event !== null\)/,
  );
  assert.match(
    lordsPage,
    /noConnectionRooms = filteredRooms\.filter\(\(candidate\) => candidate\.last_event === null\)/,
  );
  assert.match(lordsPage, /label: "Conversations", rooms: conversationRooms/);
  assert.match(lordsPage, /label: "No connection", rooms: noConnectionRooms/);
  assert.match(roomList, /flatSections[\s\S]*?<RoomRow key=\{r\.room_id\} room=\{r\}/);
});

test("Lords projects rooms and messages from the selected identity perspective", () => {
  assert.match(lordsPage, /filter\(\(peer\) => !isIdentityPeer\(peer, identity\)\)/);
  assert.match(lordsPage, /myHandle=\{identity\?\.handle\}/);
  assert.match(lordsPage, /<ObservedChatTimeline/);
  assert.match(observedTimeline, /isMine=\{mine\}/);
});

test("Lords opens on the first identity and prefers an existing conversation", () => {
  assert.match(lordsPage, /value\.identities\[0\] \?\? null/);
  assert.match(
    lordsPage,
    /observed\.find\(\(candidate\) => candidate\.last_event !== null\) \?\? observed\[0\] \?\? null/,
  );
});

test("Lords chat uses the normal timeline presentation language", () => {
  assert.match(observedTimeline, /belongsToSameTimelinePanel\(previous, event, current\[0\]\)/);
  assert.match(observedTimeline, /<MessageBubble/);
  assert.match(observedTimeline, /<WorkEventCard/);
  assert.match(observedTimeline, /<WorkManagerActivityHistory/);
  assert.match(observedTimeline, /event\.type !== "m\.reaction" && event\.type !== "m\.progress"/);
  assert.match(observedTimeline, /className="flex min-h-full flex-col justify-end"/);
  assert.doesNotMatch(lordsPage, /max-w-4xl/);
});

test("Lords can inspect each team's settings through the shared team workspace", () => {
  assert.match(lordsPage, /onOpenTeamSettings=\{\(slug\) => \{[\s\S]*?setViewedTeamSlug\(slug\)/);
  assert.match(
    lordsPage,
    /<TeamPanel[\s\S]*?slug=\{viewedTeamSlug\}[\s\S]*?initialTab="settings"[\s\S]*?readOnly/,
  );
  assert.match(teamPanel, /readOnly && item\.id === "settings"/);
  assert.match(teamPanel, /allowMessaging=\{!readOnly\}/);
  assert.match(teamPanel, /<SettingsSection team=\{team\} onSaved=\{setTeam\} readOnly=\{readOnly\}/);
});

test("Lords team settings remain visibly read-only", () => {
  assert.match(teamPanel, /settings · read-only/);
  assert.match(teamPanel, /disabled=\{!draft\.verify \|\| readOnly\}/);
  assert.match(teamPanel, /disabled=\{readOnly\}/);
  assert.match(teamPanel, /\{!readOnly \? \([\s\S]*?save settings/);
  assert.match(
    teamPanel,
    /!item\.headOnly \|\| head \|\| \(readOnly && item\.id === "settings"\)/,
  );
});
