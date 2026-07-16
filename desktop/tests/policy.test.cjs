"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PRODUCTION_RENDERER_ORIGIN,
  normalizeBadgeCount,
  permissionAllowed,
  resolveRendererUrl,
  safeDownloadUrl,
  safeExternalUrl,
  safeSuggestedFilename,
  updateFeedUrl,
} = require("../compiled/policy.js");

test("production renderer cannot be overridden", () => {
  assert.equal(
    resolveRendererUrl(true, "http://127.0.0.1:3000/chat"),
    "https://interface.teamofsilicons.com/",
  );
});

test("development renderer accepts loopback and rejects arbitrary origins", () => {
  assert.equal(resolveRendererUrl(false, "http://127.0.0.1:3000/"), "http://127.0.0.1:3000/");
  assert.throws(() => resolveRendererUrl(false, "https://evil.example/"));
});

test("external URL policy rejects executable and credentialed links", () => {
  assert.equal(safeExternalUrl("javascript:alert(1)"), null);
  assert.equal(safeExternalUrl("file:///etc/passwd"), null);
  assert.equal(safeExternalUrl("https://user:secret@example.com/"), null);
  assert.equal(safeExternalUrl("https://example.com/docs"), "https://example.com/docs");
});

test("downloads accept HTTPS, reject credentials, and sanitize filenames", () => {
  assert.equal(
    safeDownloadUrl("https://media.example/file", PRODUCTION_RENDERER_ORIGIN),
    "https://media.example/file",
  );
  assert.equal(
    safeDownloadUrl("http://media.example/file", PRODUCTION_RENDERER_ORIGIN),
    null,
  );
  assert.equal(
    safeDownloadUrl("https://user:secret@media.example/file", PRODUCTION_RENDERER_ORIGIN),
    null,
  );
  assert.equal(safeSuggestedFilename("../../report.pdf"), "report.pdf");
  assert.equal(safeSuggestedFilename(".."), "download");
});

test("permissions require the trusted main frame and explicit capability", () => {
  assert.equal(
    permissionAllowed("notifications", PRODUCTION_RENDERER_ORIGIN, PRODUCTION_RENDERER_ORIGIN, true),
    true,
  );
  assert.equal(
    permissionAllowed("notifications", "https://evil.example", PRODUCTION_RENDERER_ORIGIN, true),
    false,
  );
  assert.equal(
    permissionAllowed("geolocation", PRODUCTION_RENDERER_ORIGIN, PRODUCTION_RENDERER_ORIGIN, true),
    false,
  );
});

test("badges are finite, integral, non-negative, and bounded", () => {
  assert.equal(normalizeBadgeCount(-8), 0);
  assert.equal(normalizeBadgeCount(2.9), 2);
  assert.equal(normalizeBadgeCount(Number.NaN), 0);
  assert.equal(normalizeBadgeCount(999_999), 99_999);
});

test("signed update feeds are fixed per supported OS and architecture", () => {
  assert.equal(
    updateFeedUrl("darwin", "arm64"),
    "https://downloads.teamofsilicons.com/interface/stable/darwin/arm64",
  );
  assert.equal(
    updateFeedUrl("win32", "x64"),
    "https://downloads.teamofsilicons.com/interface/stable/win32/x64",
  );
  assert.equal(updateFeedUrl("linux", "x64"), null);
  assert.equal(updateFeedUrl("win32", "ia32"), null);
});
