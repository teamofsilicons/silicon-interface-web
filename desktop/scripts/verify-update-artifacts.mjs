import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.argv[2] ?? path.join(desktopRoot, "dist"));
const platform = process.argv[3];
const arch = process.argv[4];
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const productName = packageJson.productName ?? "Silicon Interface";

const metadataByPlatform = {
  darwin: "latest-mac.yml",
  win32: "latest.yml",
  linux: "latest-linux.yml",
};

function fail(message) {
  console.error(`verify-update-artifacts: ${message}`);
  process.exit(1);
}

if (!Object.hasOwn(metadataByPlatform, platform)) {
  fail(`platform must be one of ${Object.keys(metadataByPlatform).join(", ")}`);
}
if (!new Set(["x64", "arm64"]).has(arch)) {
  fail("architecture must be x64 or arm64");
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith("'") && trimmed.endsWith("'"))
      || (trimmed.startsWith('"') && trimmed.endsWith('"')))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseMetadata(source) {
  const files = [];
  let inFiles = false;
  let current = null;
  const top = {};

  for (const line of source.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    const topMatch = line.match(/^(version|path|sha512):\s*(.+)$/);
    if (topMatch) {
      inFiles = false;
      top[topMatch[1]] = unquote(topMatch[2]);
      continue;
    }
    if (!inFiles) continue;

    const urlMatch = line.match(/^\s{2}- url:\s*(.+)$/);
    if (urlMatch) {
      current = { url: unquote(urlMatch[1]) };
      files.push(current);
      continue;
    }
    const fieldMatch = line.match(/^\s{4}(sha512|size):\s*(.+)$/);
    if (fieldMatch && current) current[fieldMatch[1]] = unquote(fieldMatch[2]);
  }

  return { files, top };
}

function sha512(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    const stream = createReadStream(filename);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("base64")));
  });
}

function expectedNames() {
  const prefix = `${productName}-${packageJson.version}`;
  if (platform === "darwin") {
    return new Set([`${prefix}-mac-${arch}.zip`, `${prefix}-mac-${arch}.dmg`]);
  }
  if (platform === "win32") return new Set([`${prefix}-win-${arch}.exe`]);
  if (arch === "x64") {
    return new Set([`${prefix}-linux-x86_64.AppImage`, `${prefix}-linux-amd64.deb`]);
  }
  return new Set([`${prefix}-linux-arm64.AppImage`, `${prefix}-linux-arm64.deb`]);
}

const metadataName = metadataByPlatform[platform];
let source;
try {
  source = await readFile(path.join(outputRoot, metadataName), "utf8");
} catch (error) {
  fail(`cannot read ${metadataName}: ${error.message}`);
}

const metadata = parseMetadata(source);
if (metadata.top.version !== packageJson.version) {
  fail(`${metadataName} version ${metadata.top.version ?? "is missing"}; expected ${packageJson.version}`);
}
if (!metadata.top.path || !metadata.top.sha512) {
  fail(`${metadataName} is missing its primary path or SHA-512`);
}

const expected = expectedNames();
const actual = new Set(metadata.files.map((file) => file.url));
if (actual.size !== metadata.files.length) fail(`${metadataName} contains duplicate artifact URLs`);
if (
  actual.size !== expected.size
  || [...expected].some((filename) => !actual.has(filename))
) {
  fail(
    `${metadataName} lists [${[...actual].join(", ")}]; expected [${[...expected].join(", ")}]`,
  );
}

for (const file of metadata.files) {
  if (
    !file.url
    || path.basename(file.url) !== file.url
    || file.url.includes("/")
    || file.url.includes("\\")
  ) {
    fail(`unsafe artifact URL in ${metadataName}: ${file.url ?? "missing"}`);
  }
  if (!file.sha512 || !/^\d+$/.test(file.size ?? "")) {
    fail(`${file.url} is missing its size or SHA-512`);
  }

  const absolute = path.join(outputRoot, file.url);
  let information;
  try {
    information = await stat(absolute);
  } catch (error) {
    fail(`cannot read ${file.url}: ${error.message}`);
  }
  if (!information.isFile()) fail(`${file.url} is not a regular file`);
  if (information.size !== Number(file.size)) {
    fail(`${file.url} is ${information.size} bytes; metadata says ${file.size}`);
  }
  const digest = await sha512(absolute);
  if (digest !== file.sha512) fail(`${file.url} SHA-512 does not match its metadata`);
}

const primary = metadata.files.find((file) => file.url === metadata.top.path);
if (!primary) fail(`primary path ${metadata.top.path} is not present in files`);
if (primary.sha512 !== metadata.top.sha512) {
  fail(`primary SHA-512 does not match the ${metadata.top.path} file entry`);
}

console.log(
  `verify-update-artifacts: ${platform}/${arch} metadata matches ${metadata.files.length} artifacts`,
);
