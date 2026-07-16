import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.argv[2] ?? path.join(desktopRoot, "dist"));
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const ignoredNames = new Set(["SHA256SUMS.txt", "release-manifest.json"]);

async function filesBelow(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name) || entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesBelow(absolute));
    else if (entry.isFile()) found.push(absolute);
  }
  return found;
}

function sha256(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filename);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

let sourceFiles;
try {
  sourceFiles = await filesBelow(outputRoot);
} catch (error) {
  console.error(`release-manifest: cannot read ${outputRoot}: ${error.message}`);
  process.exit(1);
}

if (sourceFiles.length === 0) {
  console.error(`release-manifest: no release files found in ${outputRoot}`);
  process.exit(1);
}

const files = [];
for (const absolute of sourceFiles) {
  const relative = path.relative(outputRoot, absolute).split(path.sep).join("/");
  const info = await stat(absolute);
  files.push({
    path: relative,
    bytes: info.size,
    sha256: await sha256(absolute),
  });
}
files.sort((left, right) => left.path.localeCompare(right.path));

const manifest = {
  schema: 1,
  product: packageJson.productName ?? "Silicon Interface",
  version: packageJson.version,
  generatedAt: new Date().toISOString(),
  files,
};
const sums = files.map((file) => `${file.sha256}  ${file.path}`).join("\n") + "\n";

await writeFile(
  path.join(outputRoot, "release-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8",
);
await writeFile(path.join(outputRoot, "SHA256SUMS.txt"), sums, "utf8");
console.log(`release-manifest: hashed ${files.length} files for v${packageJson.version}`);
