"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

test("release manifest hashes nested artifacts with stable relative paths", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "silicon-release-"));
  mkdirSync(path.join(root, "darwin", "arm64"), { recursive: true });
  writeFileSync(path.join(root, "darwin", "arm64", "client.zip"), "signed payload");
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "scripts", "release-manifest.mjs"), root],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(path.join(root, "release-manifest.json"), "utf8"));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, "darwin/arm64/client.zip");
  assert.match(manifest.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.match(
    readFileSync(path.join(root, "SHA256SUMS.txt"), "utf8"),
    /  darwin\/arm64\/client\.zip\n$/,
  );
});

test("release version gate rejects a tag that does not match package version", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "..", "scripts", "verify-release-version.mjs"), "desktop-v0.0.0"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected tag/);
});

function writeUpdateCandidate(root, filename, payload = "signed candidate") {
  writeFileSync(path.join(root, filename), payload);
  return {
    size: Buffer.byteLength(payload),
    sha512: createHash("sha512").update(payload).digest("base64"),
  };
}

test("update artifact gate verifies names, sizes, and SHA-512 values", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "silicon-update-"));
  const zip = "Silicon Interface-0.1.0-mac-arm64.zip";
  const dmg = "Silicon Interface-0.1.0-mac-arm64.dmg";
  const zipInfo = writeUpdateCandidate(root, zip, "signed zip");
  const dmgInfo = writeUpdateCandidate(root, dmg, "signed dmg");
  writeFileSync(
    path.join(root, "latest-mac.yml"),
    `version: 0.1.0\nfiles:\n  - url: ${zip}\n    sha512: ${zipInfo.sha512}\n    size: ${zipInfo.size}\n  - url: ${dmg}\n    sha512: ${dmgInfo.sha512}\n    size: ${dmgInfo.size}\npath: ${zip}\nsha512: ${zipInfo.sha512}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "verify-update-artifacts.mjs"),
      root,
      "darwin",
      "arm64",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /darwin\/arm64 metadata matches 2 artifacts/);
});

test("update artifact gate rejects duplicate metadata entries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "silicon-update-"));
  const installer = "Silicon Interface-0.1.0-win-x64.exe";
  const info = writeUpdateCandidate(root, installer);
  const entry = `  - url: ${installer}\n    sha512: ${info.sha512}\n    size: ${info.size}\n`;
  writeFileSync(
    path.join(root, "latest.yml"),
    `version: 0.1.0\nfiles:\n${entry}${entry}path: ${installer}\nsha512: ${info.sha512}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "verify-update-artifacts.mjs"),
      root,
      "win32",
      "x64",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate artifact URLs/);
});

test("Windows update artifact gate requires the exact cloud-signing publisher", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "silicon-update-publisher-"));
  const installer = "Silicon Interface-0.1.0-win-x64.exe";
  const info = writeUpdateCandidate(root, installer);
  writeFileSync(
    path.join(root, "latest.yml"),
    `version: 0.1.0\nfiles:\n  - url: ${installer}\n    sha512: ${info.sha512}\n    size: ${info.size}\npath: ${installer}\nsha512: ${info.sha512}\n`,
  );
  mkdirSync(path.join(root, "win-unpacked", "resources"), { recursive: true });
  writeFileSync(
    path.join(root, "win-unpacked", "resources", "app-update.yml"),
    "provider: generic\npublisherName:\n  - \"O'Reilly: Labs\"\n",
  );

  const environment = {
    ...process.env,
    WINDOWS_SIGNING_PROVIDER: "sslcom-esigner",
    WINDOWS_PUBLISHER_NAME: "O'Reilly: Labs",
  };
  const accepted = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "verify-update-artifacts.mjs"),
      root,
      "win32",
      "x64",
    ],
    { encoding: "utf8", env: environment },
  );
  assert.equal(accepted.status, 0, accepted.stderr);

  environment.WINDOWS_PUBLISHER_NAME = "Different Publisher";
  const rejected = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "verify-update-artifacts.mjs"),
      root,
      "win32",
      "x64",
    ],
    { encoding: "utf8", env: environment },
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /do not exactly match/);
});

test("Linux arm64 update gate follows electron-builder's architecture-scoped pointer", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "silicon-linux-arm64-update-"));
  const appImage = "Silicon Interface-0.1.0-linux-arm64.AppImage";
  const deb = "Silicon Interface-0.1.0-linux-arm64.deb";
  const appImageInfo = writeUpdateCandidate(root, appImage, "arm64 appimage");
  const debInfo = writeUpdateCandidate(root, deb, "arm64 deb");
  writeFileSync(
    path.join(root, "latest-linux-arm64.yml"),
    `version: 0.1.0\nfiles:\n  - url: ${appImage}\n    sha512: ${appImageInfo.sha512}\n    size: ${appImageInfo.size}\n  - url: ${deb}\n    sha512: ${debInfo.sha512}\n    size: ${debInfo.size}\npath: ${appImage}\nsha512: ${appImageInfo.sha512}\n`,
  );

  const result = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "..", "scripts", "verify-update-artifacts.mjs"),
      root,
      "linux",
      "arm64",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /linux\/arm64 metadata matches 2 artifacts/);
});
