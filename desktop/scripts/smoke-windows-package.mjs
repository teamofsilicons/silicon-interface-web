#!/usr/bin/env node

/**
 * Bounded runtime smoke test for an unpacked Windows package.
 *
 * The packaged app owns the renderer-readiness signal: once its main frame
 * finishes loading a trusted production URL it writes an exclusive, tokenized
 * JSON record to the OS temporary directory. This runner validates that record,
 * keeps supervising the process for a stability window, and always terminates
 * the complete Chromium process tree with taskkill.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const PRODUCTION_RENDERER_ORIGIN = "https://interface.teamofsilicons.com";
const PRODUCT_EXECUTABLE = "Silicon Interface.exe";
const DEFAULT_TIMEOUT_MS = 75_000;
const DEFAULT_STABILITY_MS = 10_000;
const TERMINATION_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;
const RESULT_READ_RETRIES = 10;
const MAX_LOG_TAIL_BYTES = 64 * 1024;

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

export function createSmokeToken() {
  // base64url is inside the app's strict [A-Za-z0-9_-]{16,64} token grammar.
  return randomBytes(24).toString("base64url");
}

export function validateSmokeResult(
  record,
  { expectedArchitecture, expectedPid, expectedVersion, launchedAtMs, observedAtMs = Date.now() },
) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    fail("desktop smoke result is not a JSON object");
  }
  if (record.schema !== 1) fail(`unsupported desktop smoke schema: ${String(record.schema)}`);
  if (!Number.isSafeInteger(record.pid) || record.pid !== expectedPid) {
    fail(`desktop smoke result PID ${String(record.pid)} does not match launched PID ${expectedPid}`);
  }
  if (record.packaged !== true) fail("desktop smoke result is not from a packaged application");
  if (record.platform !== "win32") {
    fail(`desktop smoke result has unexpected platform ${JSON.stringify(record.platform)}`);
  }
  if (record.architecture !== expectedArchitecture) {
    fail(
      `desktop smoke result architecture ${JSON.stringify(record.architecture)} does not match ${JSON.stringify(expectedArchitecture)}`,
    );
  }
  if (record.appVersion !== expectedVersion) {
    fail(
      `desktop smoke result version ${JSON.stringify(record.appVersion)} does not match package version ${JSON.stringify(expectedVersion)}`,
    );
  }

  const recordedAtMs = Date.parse(record.recordedAt);
  if (!Number.isFinite(recordedAtMs)) fail("desktop smoke result has an invalid recordedAt value");
  if (recordedAtMs < launchedAtMs - 5_000 || recordedAtMs > observedAtMs + 5_000) {
    fail("desktop smoke result timestamp is outside this launch window");
  }

  if (record.status !== "ready") {
    const detail = typeof record.detail === "string" && record.detail ? ` (${record.detail})` : "";
    fail(`packaged renderer reported ${JSON.stringify(record.status)}${detail}`);
  }
  if (!isProductionRendererTarget(record.url)) {
    fail(`packaged renderer reported an untrusted URL: ${JSON.stringify(record.url)}`);
  }
  return {
    pid: record.pid,
    recordedAt: new Date(recordedAtMs).toISOString(),
    url: record.url,
  };
}

async function collectExecutables(directory, results = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectExecutables(absolute, results);
    } else if (
      entry.isFile() &&
      entry.name === PRODUCT_EXECUTABLE &&
      /^win(?:-[a-z0-9]+)?-unpacked$/i.test(path.basename(directory))
    ) {
      results.push(absolute);
    }
  }
  return results;
}

async function verifyUnpackedExecutable(executablePath) {
  const canonical = await realpath(executablePath);
  const details = await stat(canonical);
  if (!details.isFile()) fail(`Windows package executable is not a file: ${canonical}`);
  if (path.basename(canonical) !== PRODUCT_EXECUTABLE) {
    fail(`unexpected Windows package executable: ${canonical}`);
  }
  const parentName = path.basename(path.dirname(canonical));
  if (!/^win(?:-[a-z0-9]+)?-unpacked$/i.test(parentName)) {
    fail(`Windows executable is not inside an electron-builder unpacked directory: ${canonical}`);
  }
  const asarPath = path.join(path.dirname(canonical), "resources", "app.asar");
  await access(asarPath);
  if (!(await stat(asarPath)).isFile()) fail(`packaged application archive is not a file: ${asarPath}`);
  return canonical;
}

export async function resolveWindowsExecutable(inputPath) {
  const canonicalInput = await realpath(path.resolve(inputPath));
  const details = await stat(canonicalInput);
  if (details.isFile()) return verifyUnpackedExecutable(canonicalInput);
  if (!details.isDirectory()) fail(`Windows package path is not a file or directory: ${canonicalInput}`);

  const candidates = await collectExecutables(canonicalInput);
  if (candidates.length === 0) {
    fail(`no ${PRODUCT_EXECUTABLE} found in an electron-builder unpacked directory below ${canonicalInput}`);
  }
  if (candidates.length > 1) {
    fail(`multiple unpacked Windows executables found; pass one explicitly:\n${candidates.join("\n")}`);
  }
  return verifyUnpackedExecutable(candidates[0]);
}

function appendLogTail(previous, chunk) {
  const next = previous + chunk.toString("utf8");
  return next.length > MAX_LOG_TAIL_BYTES ? next.slice(-MAX_LOG_TAIL_BYTES) : next;
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function waitForExit(child, milliseconds) {
  if (!childIsRunning(child)) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(milliseconds).then(() => false),
  ]);
}

async function terminateWindowsProcessTree(child) {
  if (!child.pid || !childIsRunning(child)) return;

  const result = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    encoding: "utf8",
    timeout: TERMINATION_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error && result.error.code !== "ESRCH") {
    // Keep a direct termination fallback, but retain the taskkill error if the
    // process cannot be proven gone below.
    child.kill("SIGKILL");
  }
  if (!(await waitForExit(child, TERMINATION_TIMEOUT_MS))) {
    child.kill("SIGKILL");
    if (!(await waitForExit(child, TERMINATION_TIMEOUT_MS))) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      fail(`could not terminate packaged Windows process tree${output ? `:\n${output}` : ""}`);
    }
  }
  if (result.error || result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(
      `taskkill could not verify termination of the packaged Windows process tree` +
        `${output ? `:\n${output}` : result.error ? `: ${result.error.message}` : ""}`,
    );
  }
}

async function readSmokeResult(resultPath) {
  let lastError;
  for (let attempt = 0; attempt < RESULT_READ_RETRIES; attempt += 1) {
    try {
      return JSON.parse(await readFile(resultPath, "utf8"));
    } catch (error) {
      lastError = error;
      if (error?.code === "ENOENT") return null;
      await sleep(50);
    }
  }
  fail(`could not read desktop smoke result: ${lastError?.message ?? String(lastError)}`);
}

function parseArguments(argv) {
  let packagePath = process.env.SILICON_WINDOWS_SMOKE_PACKAGE || "dist";
  let timeoutMs = parsePositiveMilliseconds(
    process.env.SILICON_WINDOWS_SMOKE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "SILICON_WINDOWS_SMOKE_TIMEOUT_MS",
  );
  let stabilityMs = parsePositiveMilliseconds(
    process.env.SILICON_WINDOWS_SMOKE_STABILITY_MS,
    DEFAULT_STABILITY_MS,
    "SILICON_WINDOWS_SMOKE_STABILITY_MS",
  );

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--timeout-ms") {
      timeoutMs = parsePositiveMilliseconds(argv[++index], undefined, "--timeout-ms");
    } else if (value === "--stability-ms") {
      stabilityMs = parsePositiveMilliseconds(argv[++index], undefined, "--stability-ms");
    } else if (value.startsWith("-")) {
      fail(`unknown option: ${value}`);
    } else {
      packagePath = value;
    }
  }
  if (stabilityMs >= timeoutMs) fail("stability time must be shorter than the total timeout");
  return { packagePath, stabilityMs, timeoutMs };
}

async function verifyPortableExecutable(executablePath) {
  const handle = await open(executablePath, "r");
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 2 || header[0] !== 0x4d || header[1] !== 0x5a) {
      fail(`Windows package does not have an MZ executable header: ${executablePath}`);
    }
  } finally {
    await handle.close();
  }
}

export async function smokeWindowsPackage(options) {
  if (process.platform !== "win32") fail("Windows package smoke test requires Windows");

  const executablePath = await resolveWindowsExecutable(options.packagePath);
  await verifyPortableExecutable(executablePath);
  const desktopManifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  if (typeof desktopManifest.version !== "string" || !desktopManifest.version) {
    fail("desktop/package.json has no application version");
  }
  const token = createSmokeToken();
  const profilePath = path.join(os.tmpdir(), `silicon-interface-smoke-profile-${token}`);
  const resultPath = path.join(os.tmpdir(), `silicon-interface-smoke-${token}.json`);
  let stdoutTail = "";
  let stderrTail = "";
  let child;
  let spawnError = null;

  await Promise.all([
    rm(resultPath, { force: true }),
    rm(profilePath, { recursive: true, force: true }),
  ]);
  const launchedAtMs = Date.now();
  try {
    child = spawn(
      executablePath,
      [`--user-data-dir=${profilePath}`, "--no-first-run"],
      {
        env: {
          ...process.env,
          SILICON_DESKTOP_SMOKE_TOKEN: token,
          SILICON_DISABLE_UPDATES: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: false,
      },
    );
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdout.on("data", (chunk) => {
      stdoutTail = appendLogTail(stdoutTail, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = appendLogTail(stderrTail, chunk);
    });

    const deadline = launchedAtMs + options.timeoutMs;
    let validatedResult = null;
    while (Date.now() < deadline) {
      if (spawnError) fail(`could not launch packaged app: ${spawnError.message}`);
      if (!childIsRunning(child)) {
        fail(`packaged app exited before renderer readiness (exit ${child.exitCode}, signal ${child.signalCode})`);
      }
      const record = await readSmokeResult(resultPath);
      if (record) {
        validatedResult = validateSmokeResult(record, {
          expectedArchitecture: process.arch,
          expectedPid: child.pid,
          expectedVersion: desktopManifest.version,
          launchedAtMs,
        });
        break;
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
    if (!validatedResult) fail(`packaged renderer did not become ready within ${options.timeoutMs}ms`);

    console.log(`windows-smoke: production renderer loaded ${validatedResult.url}`);
    const stableUntil = Date.now() + options.stabilityMs;
    while (Date.now() < stableUntil) {
      if (!childIsRunning(child)) {
        fail(`packaged app stopped during stability window (exit ${child.exitCode}, signal ${child.signalCode})`);
      }
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, stableUntil - Date.now())));
    }
    console.log(`windows-smoke: app remained healthy for ${options.stabilityMs}ms`);
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
    let terminationError;
    try {
      if (child) await terminateWindowsProcessTree(child);
    } catch (error) {
      terminationError = error;
    }
    await Promise.all([
      rm(resultPath, { force: true }),
      rm(profilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }),
    ]);
    if (terminationError) throw terminationError;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(`windows-smoke: inspecting ${path.resolve(options.packagePath)}`);
  await smokeWindowsPackage(options);
  console.log("windows-smoke: PASS");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`windows-smoke: FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
