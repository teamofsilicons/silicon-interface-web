"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, mkdir, realpath, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let smoke;
test.before(async () => {
  smoke = await import("../scripts/smoke-windows-package.mjs");
});

test("Windows smoke accepts only the exact production renderer origin", () => {
  assert.equal(smoke.isProductionRendererTarget("https://interface.teamofsilicons.com/"), true);
  assert.equal(smoke.isProductionRendererTarget("https://interface.teamofsilicons.com/chat?room=1"), true);
  assert.equal(smoke.isProductionRendererTarget("http://interface.teamofsilicons.com/"), false);
  assert.equal(smoke.isProductionRendererTarget("https://interface.teamofsilicons.com.evil.test/"), false);
  assert.equal(smoke.isProductionRendererTarget("https://user@interface.teamofsilicons.com/"), false);
  assert.equal(smoke.isProductionRendererTarget("file:///C:/offline.html"), false);
  assert.equal(smoke.isProductionRendererTarget("not a URL"), false);
});

test("Windows smoke tokens fit the packaged app token grammar", () => {
  for (let index = 0; index < 10; index += 1) {
    assert.match(smoke.createSmokeToken(), /^[A-Za-z0-9_-]{16,64}$/);
  }
});

test("Windows smoke parses only positive integer durations", () => {
  assert.equal(smoke.parsePositiveMilliseconds(undefined, 100, "value"), 100);
  assert.equal(smoke.parsePositiveMilliseconds("250", 100, "value"), 250);
  assert.throws(() => smoke.parsePositiveMilliseconds("0", 100, "value"), /positive integer/);
  assert.throws(() => smoke.parsePositiveMilliseconds("1.5", 100, "value"), /positive integer/);
  assert.throws(() => smoke.parsePositiveMilliseconds("oops", 100, "value"), /positive integer/);
});

test("Windows smoke validates an authenticated readiness record", () => {
  const launchedAt = Date.now() - 1_000;
  const record = {
    schema: 1,
    status: "ready",
    url: "https://interface.teamofsilicons.com/chat?room=room-1",
    pid: 4242,
    appVersion: "0.1.0",
    platform: "win32",
    architecture: "x64",
    packaged: true,
    recordedAt: new Date().toISOString(),
  };
  const expected = {
    expectedArchitecture: "x64",
    expectedPid: 4242,
    expectedVersion: "0.1.0",
    launchedAtMs: launchedAt,
  };
  assert.deepEqual(smoke.validateSmokeResult(record, expected), {
    pid: 4242,
    recordedAt: record.recordedAt,
    url: record.url,
  });

  assert.throws(
    () => smoke.validateSmokeResult({ ...record, status: "load-failed", detail: "network" }, expected),
    /reported "load-failed" \(network\)/,
  );
  assert.throws(() => smoke.validateSmokeResult({ ...record, pid: 7 }, expected), /does not match/);
  assert.throws(
    () => smoke.validateSmokeResult({ ...record, packaged: false }, expected),
    /not from a packaged application/,
  );
  assert.throws(
    () => smoke.validateSmokeResult({ ...record, platform: "darwin" }, expected),
    /unexpected platform/,
  );
  assert.throws(
    () => smoke.validateSmokeResult({ ...record, architecture: "arm64" }, expected),
    /architecture .* does not match/,
  );
  assert.throws(
    () => smoke.validateSmokeResult({ ...record, appVersion: "9.9.9" }, expected),
    /does not match package version/,
  );
  assert.throws(
    () => smoke.validateSmokeResult({ ...record, url: "https://evil.test/" }, expected),
    /untrusted URL/,
  );
  assert.throws(
    () => smoke.validateSmokeResult({ ...record, recordedAt: "2000-01-01T00:00:00.000Z" }, expected),
    /outside this launch window/,
  );
});

test("Windows smoke resolves exactly one electron-builder unpacked executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "silicon-windows-smoke-test-"));
  try {
    const firstDirectory = path.join(root, "win-unpacked");
    const first = path.join(firstDirectory, "Silicon Interface.exe");
    await mkdir(path.join(firstDirectory, "resources"), { recursive: true });
    await writeFile(first, "MZ");
    await writeFile(path.join(firstDirectory, "resources", "app.asar"), "asar");
    const canonicalFirst = await realpath(first);
    assert.equal(await smoke.resolveWindowsExecutable(root), canonicalFirst);
    assert.equal(await smoke.resolveWindowsExecutable(first), canonicalFirst);

    const secondDirectory = path.join(root, "win-arm64-unpacked");
    await mkdir(path.join(secondDirectory, "resources"), { recursive: true });
    await writeFile(path.join(secondDirectory, "Silicon Interface.exe"), "MZ");
    await writeFile(path.join(secondDirectory, "resources", "app.asar"), "asar");
    await assert.rejects(() => smoke.resolveWindowsExecutable(root), /multiple unpacked Windows executables/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
