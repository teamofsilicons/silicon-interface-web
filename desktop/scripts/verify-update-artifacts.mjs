import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.resolve(process.argv[2] ?? path.join(desktopRoot, "dist"));
const platform = process.argv[3];
const arch = process.argv[4];
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const productName = packageJson.productName ?? "Silicon Interface";

const metadataByPlatform = {
  darwin: () => "latest-mac.yml",
  win32: () => "latest.yml",
  linux: (architecture) => architecture === "arm64" ? "latest-linux-arm64.yml" : "latest-linux.yml",
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
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      fail(`invalid quoted YAML scalar: ${trimmed}`);
    }
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

function parsePublisherNames(source) {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => /^publisherName:\s*/.test(line));
  if (index === -1) return [];
  const inline = lines[index].replace(/^publisherName:\s*/, "");
  if (inline) return [unquote(inline)];

  const values = [];
  for (const line of lines.slice(index + 1)) {
    const match = line.match(/^\s{2}-\s+(.+)$/);
    if (match) {
      values.push(unquote(match[1]));
      continue;
    }
    if (/^\S/.test(line)) break;
  }
  return values;
}

async function verifyWindowsPublisher(expectedPublisher) {
  const entries = await readdir(outputRoot, { withFileTypes: true });
  const unpacked = entries.filter(
    (entry) => entry.isDirectory() && /^win(?:-[a-z0-9]+)?-unpacked$/.test(entry.name),
  );
  if (unpacked.length !== 1) {
    fail(`expected exactly one unpacked Windows directory, found ${unpacked.length}`);
  }
  const filename = path.join(outputRoot, unpacked[0].name, "resources", "app-update.yml");
  const information = await lstat(filename);
  if (!information.isFile() || information.isSymbolicLink()) {
    fail("app-update.yml must be a regular file");
  }
  const publishers = parsePublisherNames(await readFile(filename, "utf8"));
  if (publishers.length !== 1 || publishers[0] !== expectedPublisher) {
    fail(
      `app-update.yml publishers [${publishers.join(", ")}] do not exactly match ${expectedPublisher}`,
    );
  }
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

function requiredCompanionNames() {
  const prefix = `${productName}-${packageJson.version}`;
  if (platform === "darwin") {
    const base = `${prefix}-mac-${arch}`;
    return [`${base}.zip.blockmap`, `${base}.dmg.blockmap`];
  }
  if (platform === "win32") {
    const base = `${prefix}-win-${arch}`;
    // Windows ARM64 intentionally uses a real ZIP-backed NSIS payload because
    // the x86 NSIS 7z plug-in cannot decode electron-builder's ARM64 executable
    // transform. electron-builder requires differentialPackage=false for that
    // payload, so ARM64 updates safely fall back to downloading the complete
    // signed installer and do not produce an EXE blockmap. x64 keeps delta
    // updates and must retain its blockmap.
    return arch === "arm64"
      ? [`${base}.zip`]
      : [`${base}.zip`, `${base}.exe.blockmap`];
  }
  return [];
}

async function requireRegularNonempty(filename) {
  const absolute = path.join(outputRoot, filename);
  let information;
  try {
    information = await lstat(absolute);
  } catch (error) {
    fail(`cannot read ${filename}: ${error.message}`);
  }
  if (!information.isFile() || information.isSymbolicLink()) {
    fail(`${filename} is not a regular file`);
  }
  if (information.size <= 0) fail(`${filename} is empty`);
  return information;
}

const metadataName = metadataByPlatform[platform](arch);
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
  if (!file.sha512) fail(`${file.url} is missing its SHA-512`);
  const allowsMissingSize = platform === "win32" && arch === "arm64";
  if (!allowsMissingSize && !/^\d+$/.test(file.size ?? "")) {
    fail(`${file.url} is missing its size`);
  }
  if (file.size !== undefined && !/^\d+$/.test(file.size)) {
    fail(`${file.url} has an invalid size`);
  }

  const absolute = path.join(outputRoot, file.url);
  const information = await requireRegularNonempty(file.url);
  if (file.size !== undefined && information.size !== Number(file.size)) {
    fail(`${file.url} is ${information.size} bytes; metadata says ${file.size}`);
  }
  const digest = await sha512(absolute);
  if (digest !== file.sha512) fail(`${file.url} SHA-512 does not match its metadata`);
}

for (const companion of requiredCompanionNames()) {
  await requireRegularNonempty(companion);
}

const primary = metadata.files.find((file) => file.url === metadata.top.path);
if (!primary) fail(`primary path ${metadata.top.path} is not present in files`);
if (primary.sha512 !== metadata.top.sha512) {
  fail(`primary SHA-512 does not match the ${metadata.top.path} file entry`);
}

const expectedPublisher = process.env.WINDOWS_PUBLISHER_NAME?.trim();
if (platform === "win32" && process.env.WINDOWS_SIGNING_PROVIDER === "sslcom-esigner") {
  if (!expectedPublisher) fail("WINDOWS_PUBLISHER_NAME is required for SSL.com eSigner");
  await verifyWindowsPublisher(expectedPublisher);
}

console.log(
  `verify-update-artifacts: ${platform}/${arch} metadata matches ${metadata.files.length} artifacts`,
);
