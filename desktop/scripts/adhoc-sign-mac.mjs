import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareMacSignature } from "./smoke-mac-engineering.mjs";

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

await prepareMacSignature(appPath, "engineering").catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

console.log(`adhoc-sign-mac: local engineering bundle is runnable at ${appPath}`);
console.log("adhoc-sign-mac: cookie encryption is disabled only because ad-hoc identities cannot own its Keychain group");
console.log("adhoc-sign-mac: this ad-hoc signature is not valid for distribution");
