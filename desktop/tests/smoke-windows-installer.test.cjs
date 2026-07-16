"use strict";

const assert = require("node:assert/strict");
const { mkdir, mkdtemp, realpath, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

let smoke;
test.before(async () => {
  smoke = await import("../scripts/smoke-windows-installer.mjs");
});

test("Windows installer name is versioned and architecture scoped", () => {
  assert.equal(
    smoke.expectedWindowsInstallerName("0.1.0", "x64"),
    "Silicon Interface-0.1.0-win-x64.exe",
  );
  assert.equal(
    smoke.expectedWindowsInstallerName("1.2.3-beta.1", "arm64"),
    "Silicon Interface-1.2.3-beta.1-win-arm64.exe",
  );
  assert.throws(() => smoke.expectedWindowsInstallerName("latest", "x64"), /invalid/);
  assert.throws(() => smoke.expectedWindowsInstallerName("0.1.0", "ia32"), /x64 or arm64/);
});

test("Windows installer signature gate is explicit and rejects ambiguous arguments", () => {
  assert.deepEqual(smoke.parseWindowsInstallerArguments(["candidate", "--require-signature"], {}), {
    packagePath: "candidate",
    requireSignature: true,
  });
  assert.equal(
    smoke.parseWindowsInstallerArguments([], { SILICON_WINDOWS_SMOKE_REQUIRE_SIGNATURE: "1" }).requireSignature,
    true,
  );
  assert.equal(smoke.parseWindowsInstallerArguments([], {}).requireSignature, false);
  assert.throws(() => smoke.parseWindowsInstallerArguments(["first", "second"], {}), /only one/);
  assert.throws(() => smoke.parseWindowsInstallerArguments(["--unsigned"], {}), /unknown option/);
});

test("Windows installer resolver ignores unpacked executables and rejects ambiguity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "silicon-windows-installer-test-"));
  const expectedName = "Silicon Interface-0.1.0-win-x64.exe";
  try {
    await mkdir(path.join(root, "win-unpacked"), { recursive: true });
    await writeFile(path.join(root, "win-unpacked", "Silicon Interface.exe"), "MZ");
    const installer = path.join(root, expectedName);
    await writeFile(installer, "MZ");
    assert.equal(
      await smoke.resolveWindowsInstaller(root, "0.1.0", "x64"),
      await realpath(installer),
    );

    const nested = path.join(root, "nested");
    await mkdir(nested);
    await writeFile(path.join(nested, expectedName), "MZ");
    await assert.rejects(
      () => smoke.resolveWindowsInstaller(root, "0.1.0", "x64"),
      /multiple/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows installer smoke waits for an asynchronous NSIS handoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "silicon-windows-installer-handoff-"));
  try {
    const pending = smoke.waitForInstalledFiles(root, 2_000);
    setTimeout(() => {
      void (async () => {
        await mkdir(path.join(root, "resources"), { recursive: true });
        await writeFile(path.join(root, "Silicon Interface.exe"), "MZ");
        await writeFile(path.join(root, "resources", "app.asar"), "asar");
        await writeFile(path.join(root, "Uninstall Silicon Interface.exe"), "MZ");
      })();
    }, 50);
    const installed = await pending;
    assert.equal(path.basename(installed.appPath), "Silicon Interface.exe");
    assert.equal(path.basename(installed.uninstallerPath), "Uninstall Silicon Interface.exe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
