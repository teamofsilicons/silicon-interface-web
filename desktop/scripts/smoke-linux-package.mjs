#!/usr/bin/env node

/**
 * Bounded runtime smoke test for an unsigned Linux engineering package.
 *
 * A DEB is installed on an ephemeral runner when passwordless sudo is
 * available; otherwise it is extracted into a disposable directory. AppImage
 * packages are always extracted so CI does not depend on FUSE. The packaged
 * executable runs under a private Xvfb display, disposable desktop/profile
 * directories, and a private D-Bus session. Update checks are disabled.
 *
 * Success is not inferred from a sleeping process. The packaged main process
 * must atomically report that its top-level renderer finished loading a URL on
 * the exact production Interface HTTPS origin. The process must then stay
 * alive for the configured stability window and stop without SIGKILL.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PRODUCTION_RENDERER_ORIGIN = "https://interface.teamofsilicons.com";
const EXPECTED_DEB_PACKAGE = "silicon-interface-desktop";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_STABILITY_MS = 10_000;
const MAX_TIMEOUT_MS = 300_000;
const COMMAND_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 12_000;
const POLL_INTERVAL_MS = 250;
const MAX_LOG_TAIL_BYTES = 64 * 1024;

function fail(message) {
  throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseBoundedMilliseconds(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_TIMEOUT_MS) {
    fail(`${label} must be a positive integer no greater than ${MAX_TIMEOUT_MS}`);
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

export function validateSmokeReceipt(record, startedAt, expected) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail("desktop smoke receipt is not an object");
  }
  if (record.schema !== 1) fail("desktop smoke receipt has an unsupported schema");
  if (record.status !== "ready") {
    const detail = typeof record.detail === "string" && record.detail ? `: ${record.detail}` : "";
    fail(`packaged app reported ${String(record.status)}${detail}`);
  }
  if (!isProductionRendererTarget(record.url)) {
    fail(`packaged app reported an unexpected renderer URL: ${String(record.url)}`);
  }
  if (!Number.isSafeInteger(record.pid) || record.pid <= 1) {
    fail("desktop smoke receipt has an invalid process id");
  }
  if (record.packaged !== true) fail("desktop smoke receipt did not come from a packaged app");
  if (record.platform !== "linux") {
    fail(`desktop smoke receipt reported unexpected platform ${String(record.platform)}`);
  }
  if (record.architecture !== expected.architecture) {
    fail(`desktop smoke receipt reported unexpected architecture ${String(record.architecture)}`);
  }
  if (record.appVersion !== expected.appVersion) {
    fail(`desktop smoke receipt reported unexpected app version ${String(record.appVersion)}`);
  }
  const recordedAt = Date.parse(record.recordedAt);
  const now = Date.now();
  if (!Number.isFinite(recordedAt) || recordedAt < startedAt - 1_000 || recordedAt > now + 5_000) {
    fail("desktop smoke receipt has an invalid or stale timestamp");
  }
  return record;
}

function hostPackageArchitecture() {
  if (process.arch === "x64") return { artifact: "x86_64", deb: "amd64" };
  if (process.arch === "arm64") return { artifact: "arm64", deb: "arm64" };
  fail(`unsupported Linux smoke architecture: ${process.arch}`);
}

function artifactKind(candidate) {
  if (/\.deb$/i.test(candidate)) return "deb";
  if (/\.AppImage$/i.test(candidate)) return "appimage";
  return null;
}

async function collectPackages(directory, results = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectPackages(absolute, results);
    else if (entry.isFile() && artifactKind(entry.name)) results.push(absolute);
  }
  return results;
}

export async function resolveLinuxPackage(inputPath, preferredKind = "auto") {
  const resolved = path.resolve(inputPath);
  const details = await stat(resolved).catch(() => null);
  if (!details) fail(`Linux package path does not exist: ${resolved}`);
  if (details.isFile()) {
    const kind = artifactKind(resolved);
    if (!kind) fail(`expected a .deb or .AppImage package: ${resolved}`);
    if (preferredKind !== "auto" && preferredKind !== kind) {
      fail(`package is ${kind}, but --format requested ${preferredKind}`);
    }
    return { kind, packagePath: await realpath(resolved) };
  }
  if (!details.isDirectory()) fail(`Linux package path is not a file or directory: ${resolved}`);

  const candidates = await collectPackages(resolved);
  const usable = preferredKind === "auto"
    ? candidates
    : candidates.filter((candidate) => artifactKind(candidate) === preferredKind);
  if (usable.length === 0) {
    fail(`no ${preferredKind === "auto" ? ".deb or .AppImage" : preferredKind} package found below ${resolved}`);
  }
  const debs = usable.filter((candidate) => artifactKind(candidate) === "deb");
  const selectedKind = preferredKind === "auto" && debs.length > 0 ? "deb" : artifactKind(usable[0]);
  const matching = usable.filter((candidate) => artifactKind(candidate) === selectedKind);
  if (matching.length !== 1) {
    fail(`multiple ${selectedKind} packages found; pass one package explicitly:\n${matching.join("\n")}`);
  }
  return { kind: selectedKind, packagePath: await realpath(matching[0]) };
}

function commandExists(command) {
  return spawnSync("sh", ["-c", "command -v \"$1\" >/dev/null 2>&1", "sh", command], {
    stdio: "ignore",
    timeout: 5_000,
  }).status === 0;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: COMMAND_TIMEOUT_MS,
    ...options,
  });
}

function runChecked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.error) fail(`${command} could not run: ${result.error.message}`);
  if (result.signal) fail(`${command} was terminated by ${result.signal}`);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

async function readDesktopVersion() {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    fail("desktop/package.json has no valid version");
  }
  return packageJson.version;
}

function hasPasswordlessSudo() {
  return commandExists("sudo") && run("sudo", ["-n", "true"], { stdio: "ignore", timeout: 5_000 }).status === 0;
}

function packageIsInstalled(packageName) {
  return run("dpkg-query", ["--show", "--showformat=${db:Status-Abbrev}", packageName], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  }).stdout === "ii ";
}

function debField(packagePath, field) {
  return runChecked("dpkg-deb", ["--field", packagePath, field]).stdout.trim();
}

async function findExecutableBelow(directory, expectedName) {
  const matches = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name === expectedName) {
        const resolved = await realpath(absolute).catch(() => null);
        if (!resolved || !resolved.startsWith(path.resolve(directory) + path.sep)) continue;
        const details = await stat(resolved).catch(() => null);
        if (details?.isFile() && (details.mode & 0o111) !== 0) matches.push(resolved);
      }
    }
  }
  await walk(directory);
  const unique = [...new Set(matches)];
  if (unique.length === 0) fail(`could not find executable ${expectedName} below ${directory}`);
  const preferred = unique.find((candidate) => candidate.includes(`${path.sep}opt${path.sep}`));
  if (preferred) return preferred;
  if (unique.length > 1) fail(`multiple ${expectedName} executables found:\n${unique.join("\n")}`);
  return unique[0];
}

function assertNoMissingLibraries(executablePath) {
  if (!commandExists("ldd")) fail("ldd is required for the Linux package smoke test");
  const result = runChecked("ldd", [executablePath]);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const missing = output.split("\n").filter((line) => /=>\s+not found\s*$/.test(line));
  if (missing.length > 0) fail(`packaged executable has missing shared libraries:\n${missing.join("\n")}`);
}

async function makeExtractedSandboxUsable(root) {
  const candidates = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name === "chrome-sandbox") candidates.push(absolute);
    }
  }
  await walk(root);
  for (const candidate of candidates) {
    // Extraction cannot preserve root ownership. Removing only the unusable
    // setuid bit makes Chromium use its user-namespace sandbox; --no-sandbox is
    // deliberately never passed.
    await chmod(candidate, 0o755);
  }
}

function assertUserNamespacesAvailable() {
  const probe = run("sysctl", ["-n", "kernel.unprivileged_userns_clone"], { timeout: 5_000 });
  if (probe.status === 0 && probe.stdout.trim() === "0") {
    fail("unprivileged user namespaces are disabled; use DEB install mode instead of extraction");
  }
}

async function prepareDeb(packagePath, scratch, requestedMode) {
  if (!commandExists("dpkg-deb") || !commandExists("dpkg-query")) {
    fail("dpkg-deb and dpkg-query are required to smoke-test a DEB package");
  }
  const version = await readDesktopVersion();
  const architecture = hostPackageArchitecture();
  const packageName = debField(packagePath, "Package");
  const packageVersion = debField(packagePath, "Version");
  const packageArchitecture = debField(packagePath, "Architecture");
  if (packageName !== EXPECTED_DEB_PACKAGE) fail(`unexpected DEB package name: ${packageName}`);
  if (packageVersion !== version) fail(`DEB version ${packageVersion} does not match ${version}`);
  if (packageArchitecture !== architecture.deb) {
    fail(`DEB architecture ${packageArchitecture} does not match host ${architecture.deb}`);
  }
  runChecked("dpkg-deb", ["--info", packagePath]);

  const canInstall = hasPasswordlessSudo();
  const mode = requestedMode === "auto" ? (canInstall ? "install" : "extract") : requestedMode;
  if (mode === "install") {
    if (!canInstall) fail("DEB install mode requires passwordless sudo");
    if (packageIsInstalled(packageName)) {
      fail(`${packageName} is already installed; use a clean runner or --deb-mode extract`);
    }
    try {
      const install = runChecked(
        "sudo",
        ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--no-install-recommends", packagePath],
      );
      if (install.stdout.trim()) console.log(install.stdout.trim());
      if (!packageIsInstalled(packageName)) fail(`apt-get did not install ${packageName}`);
      const executablePath = await realpath("/usr/bin/silicon-interface").catch(() => null);
      if (!executablePath) fail("installed DEB did not provide /usr/bin/silicon-interface");
      assertNoMissingLibraries(executablePath);
      return {
        executablePath,
        mainExecutablePath: executablePath,
        installedPackage: packageName,
        mode,
      };
    } catch (error) {
      await uninstallDeb(packageName);
      throw error;
    }
  }

  assertUserNamespacesAvailable();
  const root = path.join(scratch, "deb-root");
  runChecked("dpkg-deb", ["--extract", packagePath, root]);
  await makeExtractedSandboxUsable(root);
  const executablePath = await findExecutableBelow(root, "silicon-interface");
  assertNoMissingLibraries(executablePath);
  return {
    executablePath,
    mainExecutablePath: executablePath,
    installedPackage: null,
    mode,
  };
}

async function prepareAppImage(packagePath, scratch) {
  const architecture = hostPackageArchitecture();
  const version = await readDesktopVersion();
  const expectedName = `Silicon Interface-${version}-linux-${architecture.artifact}.AppImage`;
  if (path.basename(packagePath) !== expectedName) {
    fail(`unexpected AppImage name; expected ${expectedName}, got ${path.basename(packagePath)}`);
  }
  const fileType = runChecked("file", ["--brief", packagePath]).stdout;
  if (!/ELF 64-bit/.test(fileType)) fail(`AppImage is not a 64-bit ELF executable: ${fileType.trim()}`);

  const extractionDirectory = path.join(scratch, "appimage");
  await rm(extractionDirectory, { recursive: true, force: true });
  await mkdir(extractionDirectory, { recursive: true });
  // GitHub artifact transport normalizes executable modes. Work on a private
  // copy so both a just-built file and a downloaded artifact follow the same
  // path without mutating the candidate itself.
  const workingPackagePath = path.join(extractionDirectory, path.basename(packagePath));
  await copyFile(packagePath, workingPackagePath);
  await chmod(workingPackagePath, 0o755);
  runChecked(workingPackagePath, ["--appimage-extract"], { cwd: extractionDirectory });
  const root = path.join(extractionDirectory, "squashfs-root");
  const appRun = path.join(root, "AppRun");
  const appRunDetails = await stat(appRun).catch(() => null);
  if (!appRunDetails?.isFile() || (appRunDetails.mode & 0o111) === 0) {
    fail("AppImage extraction did not produce an executable AppRun");
  }
  assertUserNamespacesAvailable();
  await makeExtractedSandboxUsable(root);
  const electronExecutable = await findExecutableBelow(root, "silicon-interface").catch(() => appRun);
  assertNoMissingLibraries(electronExecutable);
  return {
    executablePath: appRun,
    mainExecutablePath: electronExecutable,
    installedPackage: null,
    mode: "extract",
  };
}

async function startXvfb(scratch) {
  if (!commandExists("Xvfb")) {
    fail("Xvfb is required; on Ubuntu install the xvfb package before running this smoke test");
  }
  const displayFile = path.join(scratch, "xvfb-display");
  const logPath = path.join(scratch, "xvfb.log");
  const displayHandle = await open(displayFile, "w");
  const logHandle = await open(logPath, "w");
  const child = spawn(
    "Xvfb",
    ["-displayfd", "3", "-screen", "0", "1280x800x24", "-nolisten", "tcp", "-ac"],
    {
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd, displayHandle.fd],
    },
  );
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  await displayHandle.close();
  await logHandle.close();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError) fail(`Xvfb could not start: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(`Xvfb exited during startup (exit ${child.exitCode}, signal ${child.signalCode})`);
    }
    const value = await readFile(displayFile, "utf8").catch(() => "");
    if (/^\d+\n?$/.test(value)) return { child, display: `:${value.trim()}`, logPath };
    await sleep(100);
  }
  await terminateProcessGroup(child);
  fail("Xvfb did not publish a display number within 10000ms");
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function assertMainProcessExecutable(pid, expectedExecutablePath) {
  const expected = await realpath(expectedExecutablePath);
  const actual = await readlink(`/proc/${pid}/exe`).catch(() => null);
  if (!actual) fail(`could not inspect reported desktop process ${pid}`);
  if (actual !== expected) {
    fail(`desktop smoke receipt came from unexpected executable ${actual}`);
  }
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function signalProcess(target, signal) {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(processGroupId)) return true;
    await sleep(100);
  }
  return !processGroupExists(processGroupId);
}

async function terminateProcessGroup(child, mainPid = null) {
  if (!child?.pid) return { escalated: false };
  if (mainPid && processExists(mainPid)) signalProcess(mainPid, "SIGTERM");
  else signalProcess(-child.pid, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, TERMINATION_GRACE_MS)) {
    return { escalated: false };
  }
  signalProcess(-child.pid, "SIGTERM");
  if (await waitForProcessGroupExit(child.pid, 3_000)) return { escalated: false };
  signalProcess(-child.pid, "SIGKILL");
  await waitForProcessGroupExit(child.pid, 3_000);
  return { escalated: true };
}

async function logTail(logPath) {
  const content = await readFile(logPath).catch(() => Buffer.alloc(0));
  return content.subarray(Math.max(0, content.length - MAX_LOG_TAIL_BYTES)).toString("utf8").trim();
}

async function readReceipt(resultPath, startedAt, expected) {
  let raw;
  try {
    raw = await readFile(resultPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // writeFile with exclusive creation can make the path visible a few
    // microseconds before its contents. Poll once more instead of treating
    // that harmless write window as a package failure.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  return validateSmokeReceipt(parsed, startedAt, expected);
}

async function uninstallDeb(packageName) {
  if (!packageName || !packageIsInstalled(packageName)) return true;
  const result = run(
    "sudo",
    ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "remove", "-y", packageName],
  );
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    console.error(`linux-smoke: warning: could not uninstall ${packageName}${output ? `:\n${output}` : ""}`);
    return false;
  }
  return !packageIsInstalled(packageName);
}

function parseArguments(argv) {
  let packagePath = process.env.SILICON_LINUX_SMOKE_PACKAGE || "dist";
  let format = process.env.SILICON_LINUX_SMOKE_FORMAT || "auto";
  let debMode = process.env.SILICON_LINUX_SMOKE_DEB_MODE || "auto";
  let timeoutMs = parseBoundedMilliseconds(
    process.env.SILICON_LINUX_SMOKE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "SILICON_LINUX_SMOKE_TIMEOUT_MS",
  );
  let stabilityMs = parseBoundedMilliseconds(
    process.env.SILICON_LINUX_SMOKE_STABILITY_MS,
    DEFAULT_STABILITY_MS,
    "SILICON_LINUX_SMOKE_STABILITY_MS",
  );

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--format") format = argv[++index];
    else if (value === "--deb-mode") debMode = argv[++index];
    else if (value === "--timeout-ms") {
      timeoutMs = parseBoundedMilliseconds(argv[++index], undefined, "--timeout-ms");
    } else if (value === "--stability-ms") {
      stabilityMs = parseBoundedMilliseconds(argv[++index], undefined, "--stability-ms");
    } else if (value.startsWith("-")) fail(`unknown option: ${value}`);
    else packagePath = value;
  }
  if (!["auto", "deb", "appimage"].includes(format)) {
    fail("--format must be auto, deb, or appimage");
  }
  if (!["auto", "install", "extract"].includes(debMode)) {
    fail("--deb-mode must be auto, install, or extract");
  }
  if (stabilityMs >= timeoutMs) fail("stability time must be shorter than the total timeout");
  return { packagePath, format, debMode, stabilityMs, timeoutMs };
}

export async function smokeLinuxPackage(options) {
  if (process.platform !== "linux") fail("Linux package smoke test requires Linux");
  if (process.getuid?.() === 0) fail("run the packaged application as a normal user, not root");
  const selected = await resolveLinuxPackage(options.packagePath, options.format);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "silicon-linux-smoke-"));
  const runtimeTemp = path.join(scratch, "tmp");
  const xdgConfig = path.join(scratch, "config");
  const xdgCache = path.join(scratch, "cache");
  const xdgData = path.join(scratch, "data");
  const xdgRuntime = path.join(scratch, "runtime");
  for (const directory of [runtimeTemp, xdgConfig, xdgCache, xdgData, xdgRuntime]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  let prepared = null;
  let xvfb = null;
  let child = null;
  let receipt = null;
  let runSucceeded = false;
  let terminationEscalated = false;
  let uninstallSucceeded = true;
  const appLogPath = path.join(scratch, "app.log");
  const smokeToken = `linux_${randomBytes(18).toString("base64url")}`;
  const resultPath = path.join(runtimeTemp, `silicon-interface-smoke-${smokeToken}.json`);
  const smokeProfilePath = path.join(
    runtimeTemp,
    `silicon-interface-smoke-profile-${smokeToken}`,
  );
  const expectedReceipt = {
    appVersion: await readDesktopVersion(),
    architecture: process.arch,
  };

  try {
    prepared = selected.kind === "deb"
      ? await prepareDeb(selected.packagePath, scratch, options.debMode)
      : await prepareAppImage(selected.packagePath, scratch);
    console.log(`linux-smoke: validated ${selected.kind} package (${prepared.mode} mode)`);
    xvfb = await startXvfb(scratch);
    console.log(`linux-smoke: Xvfb ready on ${xvfb.display}`);

    const appLog = await open(appLogPath, "w");
    const appArgs = ["--no-first-run", "--enable-logging=stderr"];
    const hasDbus = commandExists("dbus-run-session");
    const command = hasDbus ? "dbus-run-session" : prepared.executablePath;
    const args = hasDbus ? ["--", prepared.executablePath, ...appArgs] : appArgs;
    child = spawn(command, args, {
      detached: true,
      env: {
        ...process.env,
        DISPLAY: xvfb.display,
        HOME: scratch,
        TMPDIR: runtimeTemp,
        XDG_CACHE_HOME: xdgCache,
        XDG_CONFIG_HOME: xdgConfig,
        XDG_DATA_HOME: xdgData,
        XDG_RUNTIME_DIR: xdgRuntime,
        ELECTRON_ENABLE_LOGGING: "1",
        LIBGL_ALWAYS_SOFTWARE: "1",
        NO_AT_BRIDGE: "1",
        SILICON_DISABLE_UPDATES: "1",
        SILICON_DESKTOP_SMOKE_TOKEN: smokeToken,
      },
      stdio: ["ignore", appLog.fd, appLog.fd],
    });
    let childError = null;
    child.once("error", (error) => {
      childError = error;
    });
    await appLog.close();

    const startedAt = Date.now();
    const readinessDeadline = startedAt + options.timeoutMs - options.stabilityMs;
    while (Date.now() < readinessDeadline) {
      if (childError) fail(`packaged app could not start: ${childError.message}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(`packaged app exited before readiness (exit ${child.exitCode}, signal ${child.signalCode})`);
      }
      receipt = await readReceipt(resultPath, startedAt, expectedReceipt);
      if (receipt) break;
      await sleep(POLL_INTERVAL_MS);
    }
    if (!receipt) {
      fail(`packaged app did not report production readiness within ${options.timeoutMs - options.stabilityMs}ms`);
    }
    if (!processExists(receipt.pid)) fail(`reported desktop process ${receipt.pid} is not alive`);
    await assertMainProcessExecutable(receipt.pid, prepared.mainExecutablePath);
    console.log(`linux-smoke: packaged app reported production renderer ${receipt.url}`);

    const stableUntil = Date.now() + options.stabilityMs;
    while (Date.now() < stableUntil) {
      if (child.exitCode !== null || child.signalCode !== null || !processExists(receipt.pid)) {
        fail("packaged app stopped during the stability window");
      }
      await sleep(Math.min(POLL_INTERVAL_MS, stableUntil - Date.now()));
    }
    console.log(`linux-smoke: app remained healthy for ${options.stabilityMs}ms`);
    runSucceeded = true;
  } catch (error) {
    const appTail = await logTail(appLogPath);
    const xvfbTail = xvfb ? await logTail(xvfb.logPath) : "";
    if (appTail) console.error(`linux-smoke: app log tail:\n${appTail}`);
    if (xvfbTail) console.error(`linux-smoke: Xvfb log tail:\n${xvfbTail}`);
    throw error;
  } finally {
    if (child) {
      const termination = await terminateProcessGroup(child, receipt?.pid ?? null);
      terminationEscalated = termination.escalated;
    }
    if (xvfb?.child) await terminateProcessGroup(xvfb.child);
    uninstallSucceeded = await uninstallDeb(prepared?.installedPackage ?? null);
    await rm(resultPath, { force: true });
    await rm(smokeProfilePath, { recursive: true, force: true });
    if (process.env.SILICON_LINUX_SMOKE_KEEP_TEMP === "1") {
      console.log(`linux-smoke: kept diagnostics at ${scratch}`);
    } else {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  if (runSucceeded && terminationEscalated) {
    fail("packaged app required SIGKILL during cleanup");
  }
  if (runSucceeded && !uninstallSucceeded) {
    fail(`DEB package ${prepared?.installedPackage ?? ""} remained installed after cleanup`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(`linux-smoke: inspecting ${path.resolve(options.packagePath)}`);
  await smokeLinuxPackage(options);
  console.log("linux-smoke: PASS");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`linux-smoke: FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
