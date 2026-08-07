import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [
  lordsPage,
  lordsLayout,
  chatPage,
  lordsAddon,
  roomList,
  observedTimeline,
  teamPanel,
  roomShape,
] =
  await Promise.all([
  readFile(new URL("../../src/app/lords/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/app/lords/layout.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/app/chat/page.tsx", import.meta.url), "utf8"),
  readFile(
    new URL("../../src/components/chat/lords-sidebar-addon.tsx", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../../src/components/chat/room-list.tsx", import.meta.url), "utf8"),
  readFile(
    new URL("../../src/components/chat/observed-chat-timeline.tsx", import.meta.url),
    "utf8",
  ),
  readFile(new URL("../../src/components/teams/team-panel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../../src/lib/room-shape.ts", import.meta.url), "utf8"),
]);

test("Lords uses the normal Interface application shell", () => {
  assert.match(lordsLayout, /<AppHeader active="chat" \/>/);
  assert.match(lordsLayout, /<ChatConnectionProvider>/);
  assert.match(lordsLayout, /<TimezoneSync \/>/);
});

test("Lords partitions standard conversation rows by message history", () => {
  assert.match(
    lordsPage,
    /conversationRooms = activeRooms\.filter\(\(candidate\) => candidate\.last_event !== null\)/,
  );
  assert.match(
    lordsPage,
    /noConnectionRooms = activeRooms\.filter\(\(candidate\) => candidate\.last_event === null\)/,
  );
  assert.match(lordsPage, /label: "Conversations", rooms: conversationRooms/);
  assert.match(lordsPage, /label: "No connection", rooms: noConnectionRooms/);
  assert.match(roomList, /flatSections[\s\S]*?<RoomRow key=\{r\.room_id\} room=\{r\}/);
});

test("Lords retains revoked chats in a dedicated read-only section", () => {
  assert.match(lordsPage, /label: "Revoked access", rooms: revokedRooms/);
  assert.match(lordsPage, /candidate\.lord_access_state === "revoked"/);
  assert.match(
    lordsPage,
    /Access was revoked\. The retained history remains available only in Lords\./,
  );
  assert.match(roomShape, /raw\.lord_access_state === "active"/);
  assert.match(roomShape, /raw\.lord_access_state === "revoked"/);
});

test("Lords projects rooms and messages from the selected identity perspective", () => {
  assert.match(lordsPage, /filter\(\(peer\) => !isIdentityPeer\(peer, identity\)\)/);
  assert.match(lordsPage, /myHandle=\{identity\?\.handle\}/);
  assert.match(lordsPage, /<ObservedChatTimeline/);
  assert.match(observedTimeline, /isMine=\{mine\}/);
});

test("Lords opens as the signed-in Carbon", () => {
  assert.match(lordsPage, /const ordered = \[[\s\S]*?projectedSelf,[\s\S]*?value\.identities\.filter/);
  assert.match(lordsPage, /: projectedSelf,/);
});

test("Lords team chips filter direct chats by peer membership like Interface", () => {
  assert.match(lordsPage, /api\.teamMembers\(candidate\.slug\)/);
  assert.match(lordsPage, /membership\.member_public_id/);
  assert.match(
    lordsPage,
    /for \(const slug of peerTeams\.get\(`\$\{peer\.kind\}:\$\{peer\.id\}`\) \?\? \[\]\) slugs\.add\(slug\)/,
  );
  assert.match(lordsPage, /selectedFilters\.teams\.filter\(\(slug\) =>/);
  assert.match(lordsPage, /selectedFilters\.teams\.includes\(OTHERS_TAB\)/);
  assert.match(lordsPage, /if \(!roomMatchesSelectedTeam\(candidate\)\) return false/);
});

test("Lords keeps Silicons visible through their authoritative owner-team projection", () => {
  assert.match(
    lordsPage,
    /for \(const slug of identityTeams\.get\(`\$\{peer\.kind\}:\$\{peer\.id\}`\) \?\? \[\]\) slugs\.add\(slug\)/,
  );
  assert.match(
    lordsPage,
    /if \(identity\?\.kind === "silicon"\) \{[\s\S]*?for \(const slug of identity\.team_slugs\) slugs\.add\(slug\)/,
  );
});

test("the signed-in Lord mounts the exact normal Interface with only an identity selector added", () => {
  assert.match(lordsPage, /import ChatPage from "@\/app\/chat\/page"/);
  assert.match(
    lordsPage,
    /if \(viewingSelf && identity\) \{[\s\S]*?<LordsSidebarAddonProvider[\s\S]*?<IdentityPicker[\s\S]*?<ChatPage \/>/,
  );
  assert.match(chatPage, /const lordsSidebarBridge = useLordsSidebarBridge\(\)/);
  assert.match(chatPage, /const sidebarAddon = lordsSidebarBridge\?\.addon \?\? null/);
  assert.match(
    chatPage,
    /<TeamSlider[\s\S]*?\{sidebarAddon\}[\s\S]*?placeholder="search Carbons \+ Silicons"/,
  );
  assert.match(lordsAddon, /React\.createContext<LordsSidebarBridge \| null>\(null\)/);
  assert.match(lordsAddon, /<LordsSidebarAddonContext\.Provider value=\{value\}>/);
  assert.doesNotMatch(lordsPage, /api\.rooms\(\)/);
  assert.doesNotMatch(lordsPage, /<RoomView/);
});

test("self mode gets the normal Interface room source and complete sidebar", () => {
  assert.match(chatPage, /api\.rooms\(signal\)/);
  assert.match(chatPage, /api\.initialSync\(cursor, 50, 30, signal\)/);
  assert.match(chatPage, /<TeamSlider/);
  assert.match(chatPage, /aria-label="new chat"/);
  assert.match(chatPage, /<TeamFilterBar filters=\{filters\} onChange=\{setFilters\} \/>/);
  assert.match(chatPage, /<PaymentBanner \/>/);
  assert.match(chatPage, /groupSections=\{groupSections\}/);
  assert.match(chatPage, /archivedCount=\{archivedRoomEntry\.count\}/);
});

test("self mode gets the normal Interface conversation surface", () => {
  assert.match(chatPage, /<RoomView/);
  assert.match(chatPage, /allRooms=\{rooms\}/);
  assert.match(chatPage, /ready: socket\.ready/);
  assert.match(chatPage, /send: socket\.send/);
  assert.match(chatPage, /subscribe: subscribeFrames/);
});

test("the identity selector remains the only Lords addition in self mode", () => {
  assert.match(lordsPage, /api\.lordIdentities\("all"\)/);
  assert.match(lordsPage, /aria-label="choose identity to observe"/);
  assert.match(lordsPage, /onSelect=\{chooseIdentity\}/);
  assert.match(lordsPage, /teamName="Lord oversight"/);
});

test("team filtering never clears the observed identity or reloads the identity roster", () => {
  assert.match(lordsPage, /<TeamSlider[\s\S]*?onChange=\{setFilters\}/);
  assert.doesNotMatch(lordsPage, /setIdentity\(null\)/);
  assert.doesNotMatch(lordsPage, /setIdentities\(\[\]\)/);
  assert.doesNotMatch(lordsPage, /setLoadingIdentities\(true\)/);
  assert.match(
    lordsPage,
    /const retained = current[\s\S]*?nextRooms\.find\(\(candidate\) => candidate\.room_id === current\.room_id\)/,
  );
});

test("normal and oversight modes share filters without changing the normal Interface", () => {
  assert.match(lordsPage, /initialFilters=\{filters\}/);
  assert.match(lordsPage, /onFiltersChange=\{setFilters\}/);
  assert.match(chatPage, /lordsSidebarBridge\?\.initialFilters \?\? loadFilters\(\)/);
  assert.match(chatPage, /onLordsFiltersChange\?\.\(filters\)/);
});

test("oversight reuses the normal persisted and resizable sidebar width", () => {
  assert.match(lordsPage, /SIDEBAR_STORAGE = "silicon-interface:sidebar-width"/);
  assert.match(lordsPage, /md:w-\[var\(--sidebar-w\)\]/);
  assert.match(lordsPage, /aria-label="resize sidebar"/);
});

test("observed Lords history loads older batches at the top without jumping", () => {
  assert.match(
    lordsPage,
    /api\.lordRoomEvents\(targetRoomId, \{[\s\S]*?before,[\s\S]*?limit: LORD_EVENT_BATCH/,
  );
  assert.match(lordsPage, /setHasOlderEvents\(value\.events\.length === LORD_EVENT_BATCH\)/);
  assert.match(lordsPage, /onLoadOlder=\{loadOlderEvents\}/);
  assert.match(observedTimeline, /if \(scroller\.scrollTop <= 64\) requestOlder\(\)/);
  assert.match(
    observedTimeline,
    /anchor\.scrollTop \+ \(scroller\.scrollHeight - anchor\.scrollHeight\)/,
  );
  assert.match(observedTimeline, /Loading older messages…/);
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
