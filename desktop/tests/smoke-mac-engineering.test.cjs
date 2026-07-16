const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let smoke;

test.before(async () => {
  smoke = await import("../scripts/smoke-mac-engineering.mjs");
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

test("classifies ad-hoc, distribution, and absent signatures", () => {
  assert.equal(smoke.signatureKind("Signature=adhoc\nTeamIdentifier=not set\n"), "adhoc");
  assert.equal(
    smoke.signatureKind("Authority=Developer ID Application: Team of Silicons\nTeamIdentifier=ABCDE12345\n"),
    "distribution",
  );
  assert.equal(smoke.signatureKind("code object is not signed at all"), "unsigned");
});

test("release mode requires a timestamped Developer ID Application hardened-runtime signature", () => {
  const valid = [
    "CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+1 location=embedded",
    "Authority=Developer ID Application: Team of Silicons (ABCDE12345)",
    "TeamIdentifier=ABCDE12345",
    "Timestamp=16 Jul 2026 at 10:00:00",
  ].join("\n");
  assert.equal(smoke.releaseSignatureDetailsValid(valid), true);
  assert.equal(smoke.releaseSignatureDetailsValid(valid, "ABCDE12345"), true);
  assert.equal(smoke.releaseSignatureDetailsValid(valid, "WRONG12345"), false);
  assert.equal(smoke.releaseSignatureDetailsValid(valid.replace("Developer ID Application", "Apple Development")), false);
  assert.equal(smoke.releaseSignatureDetailsValid(valid.replace("(runtime)", "(adhoc)")), false);
  assert.equal(smoke.releaseSignatureDetailsValid(valid.replace(/^Timestamp=.+$/m, "")), false);
  assert.equal(smoke.parseSignatureMode(undefined), "engineering");
  assert.equal(smoke.parseSignatureMode("release"), "release");
  assert.throws(() => smoke.parseSignatureMode("anything"), /engineering or release/);
});

test("release fuses remain fully hardened while engineering disables only identity-bound cookies", () => {
  const hardened = {
    version: "1",
    0: 48,
    1: 49,
    2: 48,
    3: 48,
    4: 49,
    5: 49,
    7: 48,
  };
  assert.deepEqual(smoke.validateFuseStatesForMode(hardened, "release"), {
    disableCookieEncryption: false,
  });
  assert.deepEqual(smoke.validateFuseStatesForMode(hardened, "engineering"), {
    disableCookieEncryption: true,
  });
  assert.throws(
    () => smoke.validateFuseStatesForMode({ ...hardened, 0: 49 }, "release"),
    /unexpected Electron fuse at index 0/,
  );
  assert.throws(
    () => smoke.validateFuseStatesForMode({ ...hardened, 5: 48 }, "engineering"),
    /engineering app has an unexpected Electron fuse at index 5/,
  );
  assert.throws(
    () => smoke.validateFuseStatesForMode({ ...hardened, version: "2" }, "release"),
    /unsupported Electron fuse wire/,
  );
});

test("requires positive bounded timing values", () => {
  assert.equal(smoke.parsePositiveMilliseconds(undefined, 100, "value"), 100);
  assert.equal(smoke.parsePositiveMilliseconds("250", 100, "value"), 250);
  assert.throws(() => smoke.parsePositiveMilliseconds("0", 100, "value"), /positive integer/);
  assert.throws(() => smoke.parsePositiveMilliseconds("1.5", 100, "value"), /positive integer/);
  assert.throws(() => smoke.parsePositiveMilliseconds("oops", 100, "value"), /positive integer/);
});

test("accepts only a current ready receipt from the launched process and runner architecture", () => {
  const recordedAt = new Date().toISOString();
  const valid = {
    schema: 1,
    status: "ready",
    url: "https://interface.teamofsilicons.com/chat",
    pid: 1234,
    recordedAt,
    appVersion: "0.1.0",
    platform: "darwin",
    architecture: "arm64",
    packaged: true,
  };
  const expected = {
    pid: 1234,
    earliestTimestamp: Date.now() - 100,
    appVersion: "0.1.0",
    architectures: ["arm64"],
  };
  assert.equal(smoke.validateSmokeReceipt(valid, expected), valid);
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, status: "load-failed", detail: "offline" }, expected),
    /reported load-failed: offline/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, pid: 9999 }, expected),
    /unexpected process/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, url: "file:\/\/\/tmp\/offline.html" }, expected),
    /unexpected URL/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, packaged: false }, expected),
    /packaged app/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, platform: "linux" }, expected),
    /macOS/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, architecture: "x64" }, expected),
    /unexpected architecture/,
  );
  assert.throws(
    () => smoke.validateSmokeReceipt({ ...valid, appVersion: "9.9.9" }, expected),
    /unexpected app version/,
  );
  assert.throws(
    () =>
      smoke.validateSmokeReceipt(
        { ...valid, recordedAt: new Date(Date.now() - 60_000).toISOString() },
        { ...expected, earliestTimestamp: Date.now() },
      ),
    /invalid or stale timestamp/,
  );
});

test("resolves one bundle and rejects an ambiguous package directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "silicon-mac-smoke-test-"));
  try {
    const first = path.join(root, "mac", "Silicon Interface.app");
    await mkdir(first, { recursive: true });
    assert.equal(await smoke.resolveAppBundle(root), first);
    assert.equal(await smoke.resolveAppBundle(first), first);

    await mkdir(path.join(root, "mac-arm64", "Silicon Interface.app"), { recursive: true });
    await assert.rejects(() => smoke.resolveAppBundle(root), /multiple \.app bundles/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
