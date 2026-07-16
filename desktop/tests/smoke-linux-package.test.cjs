const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let smoke;

test.before(async () => {
  smoke = await import("../scripts/smoke-linux-package.mjs");
});

test("accepts only the exact HTTPS production renderer origin", () => {
  assert.equal(smoke.isProductionRendererTarget("https://interface.teamofsilicons.com/"), true);
  assert.equal(smoke.isProductionRendererTarget("https://interface.teamofsilicons.com/chat?room=1"), true);
  assert.equal(smoke.isProductionRendererTarget("http://interface.teamofsilicons.com/"), false);
  assert.equal(smoke.isProductionRendererTarget("https://interface.teamofsilicons.com.evil.test/"), false);
  assert.equal(smoke.isProductionRendererTarget("https://user@interface.teamofsilicons.com/"), false);
  assert.equal(smoke.isProductionRendererTarget("file:///tmp/offline.html"), false);
  assert.equal(smoke.isProductionRendererTarget("not a URL"), false);
});

test("requires positive bounded timing values", () => {
  assert.equal(smoke.parseBoundedMilliseconds(undefined, 100, "value"), 100);
  assert.equal(smoke.parseBoundedMilliseconds("250", 100, "value"), 250);
  assert.throws(() => smoke.parseBoundedMilliseconds("0", 100, "value"), /positive integer/);
  assert.throws(() => smoke.parseBoundedMilliseconds("1.5", 100, "value"), /positive integer/);
  assert.throws(() => smoke.parseBoundedMilliseconds("300001", 100, "value"), /no greater than/);
  assert.throws(() => smoke.parseBoundedMilliseconds("oops", 100, "value"), /positive integer/);
});

test("accepts only a current ready receipt for the production renderer", () => {
  const startedAt = Date.now() - 100;
  const valid = {
    schema: 1,
    status: "ready",
    url: "https://interface.teamofsilicons.com/chat",
    pid: 1234,
    recordedAt: new Date().toISOString(),
    packaged: true,
    platform: "linux",
    architecture: process.arch,
    appVersion: "0.1.0",
  };
  const expected = { architecture: process.arch, appVersion: "0.1.0" };
  assert.equal(smoke.validateSmokeReceipt(valid, startedAt, expected), valid);
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, status: "load-failed", detail: "offline" }, startedAt, expected),
    /reported load-failed: offline/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, pid: 0 }, startedAt, expected),
    /invalid process id/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, url: "file:///tmp/offline.html" }, startedAt, expected),
    /unexpected renderer URL/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, packaged: false }, startedAt, expected),
    /did not come from a packaged app/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, platform: "darwin" }, startedAt, expected),
    /unexpected platform/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, architecture: "unexpected" }, startedAt, expected),
    /unexpected architecture/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, appVersion: "9.9.9" }, startedAt, expected),
    /unexpected app version/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, recordedAt: new Date(startedAt - 5_000).toISOString() }, startedAt, expected),
    /invalid or stale timestamp/,
  );
});

test("resolves one package, prefers DEB, and rejects ambiguous candidates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "silicon-linux-smoke-test-"));
  try {
    const appImage = path.join(root, "Silicon Interface-0.1.0-linux-x86_64.AppImage");
    const deb = path.join(root, "Silicon Interface-0.1.0-linux-x86_64.deb");
    await writeFile(appImage, "appimage");
    await writeFile(deb, "deb");

    assert.deepEqual(await smoke.resolveLinuxPackage(root), {
      kind: "deb",
      packagePath: await require("node:fs/promises").realpath(deb),
    });
    assert.deepEqual(await smoke.resolveLinuxPackage(root, "appimage"), {
      kind: "appimage",
      packagePath: await require("node:fs/promises").realpath(appImage),
    });
    assert.deepEqual(await smoke.resolveLinuxPackage(deb), {
      kind: "deb",
      packagePath: await require("node:fs/promises").realpath(deb),
    });

    const nested = path.join(root, "nested");
    await mkdir(nested);
    await writeFile(path.join(nested, "second.deb"), "deb");
    await assert.rejects(() => smoke.resolveLinuxPackage(root), /multiple deb packages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects mismatched explicit package formats", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "silicon-linux-smoke-test-"));
  try {
    const deb = path.join(root, "candidate.deb");
    await writeFile(deb, "deb");
    await assert.rejects(() => smoke.resolveLinuxPackage(deb, "appimage"), /requested appimage/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
