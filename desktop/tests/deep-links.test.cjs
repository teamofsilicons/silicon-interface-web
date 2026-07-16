"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { parseDeepLink } = require("../compiled/deep-links.js");
const ROOM = "01KXDKNQWFVM04YQDZMD47CY76";

test("accepts closed chat and invite routes", () => {
  assert.deepEqual(parseDeepLink("silicon://chat/" + ROOM), {
    kind: "chat",
    path: "/chat?room=" + ROOM,
  });
  assert.deepEqual(parseDeepLink("https://interface.teamofsilicons.com/join/abcdefgh"), {
    kind: "join",
    path: "/join/abcdefgh",
  });
});

test("preserves only a validated message anchor", () => {
  assert.deepEqual(parseDeepLink("silicon://chat/" + ROOM + "?message=evt_123"), {
    kind: "chat",
    path: "/chat?room=" + ROOM + "&message=evt_123",
  });
  assert.equal(parseDeepLink("silicon://chat/" + ROOM + "?message=%2Fbad"), null);
});

test("rejects open redirects, arbitrary paths, and malformed identifiers", () => {
  assert.equal(parseDeepLink("https://evil.example/chat?room=" + ROOM), null);
  assert.equal(parseDeepLink("silicon://settings/profile"), null);
  assert.equal(parseDeepLink("silicon://chat/not-a-room"), null);
  assert.equal(
    parseDeepLink("https://interface.teamofsilicons.com/chat?room=" + ROOM + "&redirect=x"),
    null,
  );
});
