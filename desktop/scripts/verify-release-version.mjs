import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
const expected = `desktop-v${packageJson.version}`;

if (tag !== expected) {
  console.error(`release-version: expected tag ${expected}, received ${tag || "<empty>"}`);
  process.exit(1);
}
console.log(`release-version: ${tag} matches desktop/package.json`);
