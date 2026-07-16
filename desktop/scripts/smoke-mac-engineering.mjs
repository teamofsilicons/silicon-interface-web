#!/usr/bin/env node

/**
 * Bounded smoke test for an unpacked, non-distribution macOS engineering app.
 *
 * The script deliberately launches the bundle executable instead of `open` so
 * the process can be supervised and its entire process group can be stopped.
 * An opt-in, unguessable app-authored receipt proves the packaged renderer
 * reached the production Interface origin. The app gets a disposable Chromium
 * profile and update checks are disabled.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXPECTED_BUNDLE_ID = "ai.45d.silicon-interface";
export const PRODUCTION_RENDERER_ORIGIN = "https://interface.teamofsilicons.com";
const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINEERING_ENTITLEMENTS = path.join(DESKTOP_ROOT, "resources", "entitlements.mac.plist");
const DEFAULT_TIMEOUT_MS = 75_000;
const DEFAULT_STABILITY_MS = 10_000;
const TERMINATION_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 250;
const MAX_LOG_TAIL_BYTES = 64 * 1024;
const FUSE_DISABLED = 48;
const FUSE_ENABLED = 49;

const localRequire = createRequire(import.meta.url);

function fail(message) {
  throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parsePositiveMilliseconds(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

export function isProductionRendererTarget(candidate) {
  try {
    const parsed = new URL(candidate);
    return (
      parsed.protocol === "https:" &&
      parsed.origin === PRODUCTION_RENDERER_ORIGIN &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

export function signatureKind(details) {
  if (/^Authority=/m.test(details) || /^TeamIdentifier=(?!not set$).+/m.test(details)) {
    return "distribution";
  }
  if (/^Signature=adhoc$/m.test(details) || /^TeamIdentifier=not set$/m.test(details)) {
    return "adhoc";
  }
  return "unsigned";
}

export function releaseSignatureDetailsValid(details, expectedTeamId) {
  const teamIdentifier = details.match(/^TeamIdentifier=([A-Z0-9]+)$/m)?.[1] ?? null;
  return Boolean(
    /^Authority=Developer ID Application:/m.test(details) &&
    teamIdentifier &&
    (!expectedTeamId || teamIdentifier === expectedTeamId) &&
    /^Timestamp=.+$/m.test(details) &&
    /^CodeDirectory .+flags=.+\(runtime\)/m.test(details)
  );
}

export function parseSignatureMode(value) {
  const mode = value || "engineering";
  if (mode !== "engineering" && mode !== "release") {
    fail("signature mode must be engineering or release");
  }
  return mode;
}

export function validateFuseStatesForMode(fuseWire, mode) {
  if (fuseWire?.version !== "1") fail("packaged app uses an unsupported Electron fuse wire");
  // @electron/fuses uses the FuseV1Options numeric indexes as keys.
  const expectedCommonStates = new Map([
    [0, FUSE_DISABLED], // RunAsNode
    [2, FUSE_DISABLED], // EnableNodeOptionsEnvironmentVariable
    [3, FUSE_DISABLED], // EnableNodeCliInspectArguments
    [4, FUSE_ENABLED], // EnableEmbeddedAsarIntegrityValidation
    [5, FUSE_ENABLED], // OnlyLoadAppFromAsar
    [7, FUSE_DISABLED], // GrantFileProtocolExtraPrivileges
  ]);
  for (const [index, expected] of expectedCommonStates) {
    if (fuseWire[index] !== expected) {
      fail(`${mode} app has an unexpected Electron fuse at index ${index}`);
    }
  }
  if (mode === "release" && fuseWire[1] !== FUSE_ENABLED) {
    fail("release app has an unexpected Electron fuse at index 1");
  }
  if (mode === "engineering" && !new Set([FUSE_DISABLED, FUSE_ENABLED]).has(fuseWire[1])) {
    fail("engineering app has an unexpected Electron fuse at index 1");
  }
  return { disableCookieEncryption: mode === "engineering" && fuseWire[1] === FUSE_ENABLED };
}

async function prepareFuses(appPath, mode) {
  // electron-builder owns this pinned transitive tool. Resolve from the builder
  // package so pnpm's strict node_modules layout remains deterministic.
  const builderRequire = createRequire(localRequire.resolve("electron-builder"));
  const fuses = builderRequire("@electron/fuses");
  const current = await fuses.getCurrentFuseWire(appPath);
  const action = validateFuseStatesForMode(current, mode);
  if (!action.disableCookieEncryption) return;

  // Cookie encryption is deliberately enabled in signed production builds.
  // On an ad-hoc identity macOS has no stable Developer ID team for the Keychain
  // access group, and Electron's network service cannot initialize. Disable only
  // this identity-dependent fuse in the disposable branch-CI candidate, then
  // re-sign after this final binary mutation. Release mode never mutates fuses.
  await fuses.flipFuses(appPath, {
    version: fuses.FuseVersion.V1,
    [fuses.FuseV1Options.EnableCookieEncryption]: false,
  });
  const updated = await fuses.getCurrentFuseWire(appPath);
  if (validateFuseStatesForMode(updated, mode).disableCookieEncryption) {
    fail("engineering cookie-encryption fuse remained enabled after mutation");
  }
  console.log("mac-smoke: disabled identity-bound cookie encryption for ad-hoc engineering run");
}

async function collectAppBundles(directory, results = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      results.push(absolute);
      continue;
    }
    if (entry.isDirectory()) await collectAppBundles(absolute, results);
  }
  return results;
}

export async function resolveAppBundle(inputPath) {
  const resolved = path.resolve(inputPath);
  const details = await stat(resolved).catch(() => null);
  if (!details?.isDirectory()) fail(`macOS package path is not a directory: ${resolved}`);
  if (resolved.endsWith(".app")) return resolved;

  const apps = await collectAppBundles(resolved);
  if (apps.length === 0) fail(`no .app bundle found below ${resolved}`);
  if (apps.length > 1) {
    fail(`multiple .app bundles found; pass one bundle explicitly:\n${apps.join("\n")}`);
  }
  return apps[0];
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

function plistValue(infoPlist, key) {
  return runChecked("plutil", ["-extract", key, "raw", "-o", "-", infoPlist]).stdout.trim();
}

function inspectSignature(appPath) {
  const result = spawnSync("codesign", ["--display", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  return {
    details: [result.stdout, result.stderr].filter(Boolean).join("\n"),
    present: result.status === 0,
  };
}

function signatureIsValid(appPath) {
  return (
    spawnSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
      encoding: "utf8",
    }).status === 0
  );
}

function hasRequiredEngineeringEntitlements(appPath) {
  const result = spawnSync("codesign", ["--display", "--entitlements", ":-", appPath], {
    encoding: "utf8",
  });
  return (
    result.status === 0 &&
    result.stdout.includes("<key>com.apple.security.cs.allow-jit</key>") &&
    result.stdout.includes("<key>com.apple.security.cs.allow-unsigned-executable-memory</key>")
  );
}

function ensureSignature(appPath, mode) {
  const before = inspectSignature(appPath);
  const kind = signatureKind(before.details);

  if (mode === "release") {
    const expectedTeamId = process.env.APPLE_TEAM_ID?.trim();
    if (!expectedTeamId) fail("release smoke requires APPLE_TEAM_ID to pin the signing identity");
    if (kind !== "distribution" || !releaseSignatureDetailsValid(before.details, expectedTeamId)) {
      fail("release smoke requires a timestamped Developer ID Application signature with hardened runtime");
    }
    if (!signatureIsValid(appPath)) fail("release app has an invalid distribution signature");
    console.log("mac-smoke: valid Developer ID Application signature; bundle left unchanged");
    return;
  }

  // This test is intentionally unable to rewrite a release candidate. A real
  // Apple identity must survive untouched for notarization and Gatekeeper QA.
  if (kind === "distribution") {
    fail("refusing to run the engineering smoke test on a distribution-signed app");
  }

  if (kind === "adhoc" && signatureIsValid(appPath) && hasRequiredEngineeringEntitlements(appPath)) {
    console.log("mac-smoke: existing ad-hoc signature and Electron JIT entitlements are valid");
    return;
  }

  // Fuses mutate the executable after electron-builder's signing stage. Sign
  // once more with the canonical Electron JIT entitlements so an arm64 runner
  // does not get a superficially valid bundle whose network/renderer helpers
  // crash at runtime.
  const args = [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    "--options",
    "runtime",
    "--entitlements",
    ENGINEERING_ENTITLEMENTS,
  ];
  args.push(appPath);
  runChecked("codesign", args);
  runChecked("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  if (!hasRequiredEngineeringEntitlements(appPath)) {
    fail("ad-hoc signature is missing required Electron JIT entitlements");
  }
  console.log("mac-smoke: applied and verified an ad-hoc engineering signature");
}

export async function prepareMacSignature(appPath, mode = "engineering") {
  const signatureMode = parseSignatureMode(mode);
  if (
    signatureMode === "engineering" &&
    signatureKind(inspectSignature(appPath).details) === "distribution"
  ) {
    fail("refusing to run the engineering smoke test on a distribution-signed app");
  }
  await prepareFuses(appPath, signatureMode);
  ensureSignature(appPath, signatureMode);
}

function appendLogTail(previous, chunk) {
  const next = previous + chunk.toString("utf8");
  return next.length > MAX_LOG_TAIL_BYTES ? next.slice(-MAX_LOG_TAIL_BYTES) : next;
}

export function validateSmokeReceipt(receipt, expected) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    fail("desktop smoke result is not an object");
  }
  if (receipt.schema !== 1) fail("desktop smoke result has an unsupported schema");
  if (receipt.pid !== expected.pid) fail("desktop smoke result came from an unexpected process");
  const recordedAt = Date.parse(receipt.recordedAt);
  if (!Number.isFinite(recordedAt) || recordedAt < expected.earliestTimestamp - 2_000) {
    fail("desktop smoke result has an invalid or stale timestamp");
  }
  if (recordedAt > Date.now() + 5_000) fail("desktop smoke result timestamp is in the future");
  if (receipt.status !== "ready") {
    const detail = typeof receipt.detail === "string" && receipt.detail ? `: ${receipt.detail}` : "";
    fail(`packaged renderer reported ${String(receipt.status)}${detail}`);
  }
  if (!isProductionRendererTarget(receipt.url)) {
    fail(`packaged renderer reported an unexpected URL: ${String(receipt.url)}`);
  }
  if (receipt.packaged !== true) fail("desktop smoke result did not come from a packaged app");
  if (receipt.platform !== "darwin") fail("desktop smoke result did not come from macOS");
  if (!expected.architectures.includes(receipt.architecture)) {
    fail(`desktop smoke result has unexpected architecture: ${String(receipt.architecture)}`);
  }
  if (receipt.appVersion !== expected.appVersion) {
    fail(`desktop smoke result has unexpected app version: ${String(receipt.appVersion)}`);
  }
  return receipt;
}

async function readSmokeReceipt(resultPath, expected) {
  try {
    const contents = await readFile(resultPath, "utf8");
    return validateSmokeReceipt(JSON.parse(contents), expected);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(milliseconds).then(() => false),
  ]);
}

async function terminateProcessGroup(child) {
  if (!child.pid) return;
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };

  signalGroup("SIGTERM");
  if (!(await waitForExit(child, TERMINATION_GRACE_MS))) {
    signalGroup("SIGKILL");
    await waitForExit(child, TERMINATION_GRACE_MS);
  }
  // The group may retain a Chromium helper after its leader exits.
  signalGroup("SIGKILL");
}

function parseArguments(argv) {
  let packagePath = process.env.SILICON_MAC_SMOKE_APP || "dist";
  let timeoutMs = parsePositiveMilliseconds(
    process.env.SILICON_MAC_SMOKE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "SILICON_MAC_SMOKE_TIMEOUT_MS",
  );
  let stabilityMs = parsePositiveMilliseconds(
    process.env.SILICON_MAC_SMOKE_STABILITY_MS,
    DEFAULT_STABILITY_MS,
    "SILICON_MAC_SMOKE_STABILITY_MS",
  );
  let signatureMode = parseSignatureMode(process.env.SILICON_MAC_SMOKE_SIGNATURE_MODE);

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--timeout-ms") {
      const optionValue = argv[++index];
      if (!optionValue || optionValue.startsWith("-")) fail("--timeout-ms requires a value");
      timeoutMs = parsePositiveMilliseconds(optionValue, undefined, "--timeout-ms");
    } else if (value === "--stability-ms") {
      const optionValue = argv[++index];
      if (!optionValue || optionValue.startsWith("-")) fail("--stability-ms requires a value");
      stabilityMs = parsePositiveMilliseconds(optionValue, undefined, "--stability-ms");
    } else if (value === "--signature-mode") {
      const optionValue = argv[++index];
      if (!optionValue || optionValue.startsWith("-")) fail("--signature-mode requires a value");
      signatureMode = parseSignatureMode(optionValue);
    } else if (value.startsWith("-")) {
      fail(`unknown option: ${value}`);
    } else {
      packagePath = value;
    }
  }
  if (stabilityMs >= timeoutMs) fail("stability time must be shorter than the total timeout");
  return { packagePath, signatureMode, stabilityMs, timeoutMs };
}

async function preflightBundle(appPath) {
  const canonicalAppPath = await realpath(appPath);
  const infoPlist = path.join(canonicalAppPath, "Contents", "Info.plist");
  await access(infoPlist);

  const bundleId = plistValue(infoPlist, "CFBundleIdentifier");
  if (bundleId !== EXPECTED_BUNDLE_ID) {
    fail(`unexpected bundle identifier ${JSON.stringify(bundleId)}`);
  }
  const executableName = plistValue(infoPlist, "CFBundleExecutable");
  if (!executableName || path.basename(executableName) !== executableName) {
    fail("invalid CFBundleExecutable in Info.plist");
  }
  const executablePath = await realpath(
    path.join(canonicalAppPath, "Contents", "MacOS", executableName),
  );
  const executableRoot = path.join(canonicalAppPath, "Contents", "MacOS") + path.sep;
  if (!executablePath.startsWith(executableRoot)) fail("bundle executable escapes Contents/MacOS");
  const executableStat = await stat(executablePath);
  if (!executableStat.isFile() || (executableStat.mode & 0o111) === 0) {
    fail("bundle executable is missing or not executable");
  }
  const appVersion = plistValue(infoPlist, "CFBundleShortVersionString");
  const packageMetadata = JSON.parse(await readFile(path.join(DESKTOP_ROOT, "package.json"), "utf8"));
  if (appVersion !== packageMetadata.version) {
    fail(`bundle version ${appVersion} does not match desktop package ${packageMetadata.version}`);
  }
  const architectures = runChecked("lipo", ["-archs", executablePath])
    .stdout.trim()
    .split(/\s+/)
    .filter((architecture) => architecture === "arm64" || architecture === "x86_64")
    .map((architecture) => (architecture === "x86_64" ? "x64" : architecture));
  if (architectures.length === 0) fail("bundle executable has no supported macOS architecture");
  if (!architectures.includes(process.arch)) {
    fail(`bundle cannot run on the current ${process.arch} Node/runner architecture`);
  }
  return { appPath: canonicalAppPath, appVersion, architectures, executablePath };
}

export async function smokeMacEngineering(options) {
  if (process.platform !== "darwin") fail("macOS engineering smoke test requires macOS");
  const { appPath, appVersion, architectures, executablePath } = await preflightBundle(
    await resolveAppBundle(options.packagePath),
  );
  const signatureMode = options.signatureMode || "engineering";
  await prepareMacSignature(appPath, signatureMode);

  const smokeToken = randomBytes(24).toString("base64url");
  const resultPath = path.join(os.tmpdir(), `silicon-interface-smoke-${smokeToken}.json`);
  const profilePath = path.join(os.tmpdir(), `silicon-interface-smoke-profile-${smokeToken}`);
  await rm(resultPath, { force: true });
  await rm(profilePath, { recursive: true, force: true });
  let stdoutTail = "";
  let stderrTail = "";
  let child;

  try {
    child = spawn(
      executablePath,
      ["--no-first-run"],
      {
        detached: true,
        env: {
          ...process.env,
          SILICON_DISABLE_UPDATES: "1",
          SILICON_DESKTOP_SMOKE_TOKEN: smokeToken,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.on("data", (chunk) => {
      stdoutTail = appendLogTail(stdoutTail, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = appendLogTail(stderrTail, chunk);
    });

    const startedAt = Date.now();
    let receipt = null;
    while (Date.now() - startedAt < options.timeoutMs) {
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(`packaged app exited before loading production (exit ${child.exitCode}, signal ${child.signalCode})`);
      }
      receipt = await readSmokeReceipt(resultPath, {
        appVersion,
        architectures: [process.arch],
        earliestTimestamp: startedAt,
        pid: child.pid,
      });
      if (receipt) break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (!receipt) {
      fail(`packaged app did not report production readiness within ${options.timeoutMs}ms`);
    }

    console.log(`mac-smoke: packaged app reported production renderer ${receipt.url}`);
    const stableUntil = Date.now() + options.stabilityMs;
    while (Date.now() < stableUntil) {
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(`packaged app stopped during stability window (exit ${child.exitCode}, signal ${child.signalCode})`);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, stableUntil - Date.now()));
    }
    console.log(`mac-smoke: app remained healthy for ${options.stabilityMs}ms`);
  } catch (error) {
    const diagnostics = [
      stdoutTail.trim() ? `stdout tail:\n${stdoutTail.trim()}` : "",
      stderrTail.trim() ? `stderr tail:\n${stderrTail.trim()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (diagnostics) console.error(diagnostics);
    throw error;
  } finally {
    if (child) await terminateProcessGroup(child);
    await rm(resultPath, { force: true });
    await rm(profilePath, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(`mac-smoke: inspecting ${path.resolve(options.packagePath)}`);
  await smokeMacEngineering(options);
  console.log("mac-smoke: PASS");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`mac-smoke: FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
