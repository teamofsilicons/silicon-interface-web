import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.argv[2] ?? path.join(desktopRoot, "dist-local"));

function fail(message) {
  console.error(`adhoc-sign-mac: ${message}`);
  process.exit(1);
}

if (process.platform !== "darwin") fail("this engineering helper runs only on macOS");

async function findApp(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name.endsWith(".app")) return absolute;
    if (entry.isDirectory()) {
      const nested = await findApp(absolute).catch(() => null);
      if (nested) return nested;
    }
  }
  return null;
}

const appPath = await findApp(outputRoot).catch(() => null);
if (!appPath) fail(`no .app bundle found below ${outputRoot}`);

const signed = spawnSync(
  "codesign",
  ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
  { encoding: "utf8" },
);
if (signed.status !== 0) fail(`codesign failed\n${signed.stderr}`);

const verified = spawnSync(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", appPath],
  { encoding: "utf8" },
);
if (verified.status !== 0) fail(`signature verification failed\n${verified.stderr}`);

console.log(`adhoc-sign-mac: local engineering bundle is runnable at ${appPath}`);
console.log("adhoc-sign-mac: this ad-hoc signature is not valid for distribution");
