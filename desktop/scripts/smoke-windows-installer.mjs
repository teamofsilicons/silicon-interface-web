#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT_EXECUTABLE = "Silicon Interface.exe";
const COMMAND_TIMEOUT_MS = 180_000;
const REMOVE_TIMEOUT_MS = 20_000;

function fail(message) {
  throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function desktopVersion() {
  const manifest = JSON.parse(await readFile(path.join(DESKTOP_ROOT, "package.json"), "utf8"));
  if (typeof manifest.version !== "string" || !manifest.version) {
    fail("desktop/package.json has no application version");
  }
  return manifest.version;
}

function windowsArchitecture() {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  fail(`unsupported Windows installer architecture: ${process.arch}`);
}

export function expectedWindowsInstallerName(version, architecture) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail("invalid desktop version");
  }
  if (architecture !== "x64" && architecture !== "arm64") {
    fail("Windows installer architecture must be x64 or arm64");
  }
  return `Silicon Interface-${version}-win-${architecture}.exe`;
}

async function collectInstallers(directory, expectedName, results = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && !/-unpacked$/i.test(entry.name)) {
      await collectInstallers(absolute, expectedName, results);
    } else if (entry.isFile() && entry.name === expectedName) {
      results.push(absolute);
    }
  }
  return results;
}

export async function resolveWindowsInstaller(inputPath, version, architecture) {
  const expectedName = expectedWindowsInstallerName(version, architecture);
  const candidate = path.resolve(inputPath);
  const details = await stat(candidate).catch(() => null);
  if (!details) fail(`Windows installer path does not exist: ${candidate}`);
  if (details.isFile()) {
    if (path.basename(candidate) !== expectedName) {
      fail(`unexpected Windows installer name; expected ${expectedName}`);
    }
    return realpath(candidate);
  }
  if (!details.isDirectory()) fail(`Windows installer path is not a file or directory: ${candidate}`);
  const installers = await collectInstallers(candidate, expectedName);
  if (installers.length === 0) fail(`no ${expectedName} found below ${candidate}`);
  if (installers.length > 1) fail(`multiple ${expectedName} files found below ${candidate}`);
  return realpath(installers[0]);
}

async function assertPortableExecutable(filename) {
  const handle = await open(filename, "r");
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 2 || header.toString("ascii") !== "MZ") {
      fail(`${path.basename(filename)} is not a Windows executable`);
    }
  } finally {
    await handle.close();
  }
}

async function findInstalledFiles(installDirectory) {
  const appPath = path.join(installDirectory, PRODUCT_EXECUTABLE);
  await access(appPath);
  await access(path.join(installDirectory, "resources", "app.asar"));
  const uninstallers = (await readdir(installDirectory))
    .filter((name) => /^Uninstall .+\.exe$/i.test(name))
    .map((name) => path.join(installDirectory, name));
  if (uninstallers.length !== 1) {
    fail(`expected exactly one NSIS uninstaller, found ${uninstallers.length}`);
  }
  await assertPortableExecutable(appPath);
  await assertPortableExecutable(uninstallers[0]);
  return { appPath, uninstallerPath: uninstallers[0] };
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) fail(`${path.basename(command)} could not run: ${result.error.message}`);
  if (result.signal) fail(`${path.basename(command)} was terminated by ${result.signal}`);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${path.basename(command)} exited ${result.status}${output ? `:\n${output}` : ""}`);
  }
}

async function waitUntilRemoved(filename) {
  const deadline = Date.now() + REMOVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exists = await stat(filename).then(() => true).catch(() => false);
    if (!exists) return;
    await sleep(200);
  }
  fail(`NSIS uninstall left ${filename}`);
}

export async function smokeWindowsInstaller(packagePath) {
  if (process.platform !== "win32") fail("Windows installer smoke test requires Windows");
  const version = await desktopVersion();
  const architecture = windowsArchitecture();
  const installerPath = await resolveWindowsInstaller(packagePath, version, architecture);
  await assertPortableExecutable(installerPath);

  const scratch = await mkdtemp(path.join(os.tmpdir(), "silicon-windows-install-smoke-"));
  const installDirectory = path.join(scratch, "installed");
  let installed = null;
  try {
    // NSIS requires /D to be the final argument and accepts it without quotes
    // when the process API passes the complete value as one argument.
    run(installerPath, ["/S", `/D=${installDirectory}`]);
    installed = await findInstalledFiles(installDirectory);
    console.log(`windows-installer-smoke: installed ${version}/${architecture}`);

    run(installed.uninstallerPath, ["/S"]);
    await waitUntilRemoved(installed.appPath);
    installed = null;
    console.log("windows-installer-smoke: uninstall removed the application");
  } finally {
    if (installed) {
      try {
        run(installed.uninstallerPath, ["/S"]);
      } catch (error) {
        console.error(`windows-installer-smoke: cleanup warning: ${error.message}`);
      }
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const packagePath = process.argv[2] ?? path.join(DESKTOP_ROOT, "dist");
  console.log(`windows-installer-smoke: inspecting ${path.resolve(packagePath)}`);
  await smokeWindowsInstaller(packagePath);
  console.log("windows-installer-smoke: PASS");
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(`windows-installer-smoke: FAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
