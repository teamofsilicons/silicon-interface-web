import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FEED_ASSETS = new Map([
  ["darwin/x64", [".dmg", ".zip"]],
  ["darwin/arm64", [".dmg", ".zip"]],
  ["win32/x64", [".exe", ".zip"]],
  ["win32/arm64", [".exe", ".zip"]],
  ["linux/x64", [".AppImage", ".deb"]],
  ["linux/arm64", [".AppImage", ".deb"]],
]);
const SUMMARY_ASSETS = new Set([
  "desktop.sbom.cdx.json",
  "SHA256SUMS.txt",
  "release-manifest.json",
]);

function sha256(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filename);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function directFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`GitHub release rejects symbolic link: ${absolute}`);
    if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export async function planGitHubAssets(releaseRoot) {
  const root = path.resolve(releaseRoot);
  const selected = [];
  for (const [feed, extensions] of FEED_ASSETS) {
    const files = await directFiles(path.join(root, feed));
    for (const extension of extensions) {
      const matches = files.filter((filename) => filename.endsWith(extension));
      if (matches.length !== 1) {
        throw new Error(`GitHub release expected exactly one ${extension} asset in ${feed}`);
      }
      selected.push(matches[0]);
    }
  }
  for (const summary of SUMMARY_ASSETS) selected.push(path.join(root, summary));

  const names = new Set();
  const plan = [];
  for (const source of selected) {
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`GitHub release asset is missing or unsafe: ${source}`);
    }
    const name = path.basename(source);
    if (names.has(name)) throw new Error(`GitHub release asset name is not unique: ${name}`);
    names.add(name);
    plan.push({ source, name, bytes: info.size, sha256: await sha256(source) });
  }
  return plan.sort((left, right) => left.name.localeCompare(right.name));
}

function validateInputs(repository, tag) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    throw new Error("GITHUB_REPOSITORY is missing or invalid");
  }
  if (!/^desktop-v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) {
    throw new Error("desktop release tag is invalid");
  }
}

function gh(args, { allowNotFound = false } = {}) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status === 0) return result.stdout;
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (allowNotFound && /(?:HTTP 404|release not found)/i.test(detail)) return null;
  throw new Error(`gh ${args[0]} failed: ${detail || `exit ${result.status}`}`);
}

function getRelease(repository, tag, runGh = gh) {
  const output = runGh(
    ["api", `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`],
    { allowNotFound: true },
  );
  return output === null ? null : JSON.parse(output);
}

function verifyAssets(release, plan, { requireComplete }) {
  if (!release || !Array.isArray(release.assets)) throw new Error("GitHub returned an invalid release");
  const expected = new Map(plan.map((entry) => [entry.name, entry]));
  const seen = new Set();
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== "string" || seen.has(asset.name)) {
      throw new Error("GitHub release contains an invalid or duplicate asset");
    }
    seen.add(asset.name);
    const entry = expected.get(asset.name);
    if (!entry) throw new Error(`GitHub draft contains unexpected asset: ${asset.name}`);
    if (asset.size !== entry.bytes || asset.digest !== `sha256:${entry.sha256}`) {
      throw new Error(`GitHub draft asset conflicts with local bytes: ${asset.name}`);
    }
  }
  if (requireComplete && seen.size !== plan.length) {
    const missing = plan.filter((entry) => !seen.has(entry.name)).map((entry) => entry.name);
    throw new Error(`GitHub draft is missing assets: ${missing.join(", ")}`);
  }
  return seen;
}

export async function prepareGitHubRelease({ releaseRoot, repository, tag, runGh = gh }) {
  validateInputs(repository, tag);
  const plan = await planGitHubAssets(releaseRoot);
  let release = getRelease(repository, tag, runGh);
  if (!release) {
    runGh([
      "release", "create", tag,
      "--repo", repository,
      "--draft",
      "--verify-tag",
      "--generate-notes",
      "--title", `Silicon Interface ${tag.slice("desktop-v".length)}`,
    ]);
    release = getRelease(repository, tag, runGh);
  }
  if (release?.draft !== true) throw new Error(`GitHub release ${tag} is already public`);

  const existing = verifyAssets(release, plan, { requireComplete: false });
  for (const entry of plan) {
    if (existing.has(entry.name)) continue;
    runGh(["release", "upload", tag, entry.source, "--repo", repository]);
  }
  release = getRelease(repository, tag, runGh);
  verifyAssets(release, plan, { requireComplete: true });
  console.log(`github-release: prepared verified draft ${tag} with ${plan.length} assets`);
  return plan;
}

export async function finalizeGitHubRelease({ releaseRoot, repository, tag, runGh = gh }) {
  validateInputs(repository, tag);
  const plan = await planGitHubAssets(releaseRoot);
  const release = getRelease(repository, tag, runGh);
  if (release?.draft !== true) throw new Error(`GitHub release ${tag} is missing or already public`);
  verifyAssets(release, plan, { requireComplete: true });
  runGh(["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"]);
  const published = getRelease(repository, tag, runGh);
  if (!published || published.draft !== false) throw new Error(`GitHub release ${tag} did not publish`);
  verifyAssets(published, plan, { requireComplete: true });
  console.log(`github-release: published ${tag}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [operation, releaseRoot, tag] = process.argv.slice(2);
  try {
    const options = {
      releaseRoot,
      repository: process.env.GITHUB_REPOSITORY,
      tag,
    };
    if (operation === "prepare") await prepareGitHubRelease(options);
    else if (operation === "finalize") await finalizeGitHubRelease(options);
    else throw new Error("usage: publish-github-release.mjs <prepare|finalize> <release-directory> <tag>");
  } catch (error) {
    console.error(`github-release: ${error.message}`);
    process.exit(1);
  }
}
