import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_PREFIX = "interface/stable";
const FEED_POINTERS = new Map([
  ["darwin/x64", "latest-mac.yml"],
  ["darwin/arm64", "latest-mac.yml"],
  ["win32/x64", "latest.yml"],
  ["win32/arm64", "latest.yml"],
  ["linux/x64", "latest-linux.yml"],
  ["linux/arm64", "latest-linux-arm64.yml"],
]);
const SUMMARY_ORDER = [
  "desktop.sbom.cdx.json",
  "SHA256SUMS.txt",
  "release-manifest.json",
];
const IMMUTABLE_CACHE = "public,max-age=31536000,immutable";
const MUTABLE_CACHE = "no-cache,no-store,must-revalidate";

function sha256(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filename);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function filesBelow(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`release publish rejects symbolic link: ${absolute}`);
    }
    if (entry.isDirectory()) files.push(...await filesBelow(root, absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`release publish rejects non-file entry: ${absolute}`);
  }
  return files;
}

function contentType(relative) {
  if (relative.endsWith(".yml")) return "application/yaml";
  if (relative.endsWith(".json")) return "application/json";
  if (relative.endsWith(".txt")) return "text/plain; charset=utf-8";
  return null;
}

function safeRelative(root, absolute) {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`release file escapes root: ${absolute}`);
  }
  return relative;
}

export async function planRelease(releaseRoot) {
  const root = path.resolve(releaseRoot);
  const found = await filesBelow(root);
  const byRelative = new Map(found.map((absolute) => [safeRelative(root, absolute), absolute]));
  const feedPaths = new Set(FEED_POINTERS.keys());

  for (const summary of SUMMARY_ORDER) {
    if (!byRelative.has(summary)) throw new Error(`release publish is missing ${summary}`);
  }

  for (const relative of byRelative.keys()) {
    if (!SUMMARY_ORDER.includes(relative) && !feedPaths.has(path.posix.dirname(relative))) {
      throw new Error(`release publish found file outside an architecture feed: ${relative}`);
    }
  }

  const pointerPaths = new Set();
  for (const [feed, pointer] of FEED_POINTERS) {
    const expected = `${feed}/${pointer}`;
    if (!byRelative.has(expected)) throw new Error(`release publish is missing ${expected}`);
    const yamlInFeed = [...byRelative.keys()].filter(
      (relative) => path.posix.dirname(relative) === feed && relative.endsWith(".yml"),
    );
    if (yamlInFeed.length !== 1 || yamlInFeed[0] !== expected) {
      throw new Error(`release publish expected exactly ${expected} in ${feed}`);
    }
    const payloadInFeed = [...byRelative.keys()].filter(
      (relative) => path.posix.dirname(relative) === feed && !relative.endsWith(".yml"),
    );
    if (payloadInFeed.length === 0) throw new Error(`release publish found no payload in ${feed}`);
    pointerPaths.add(expected);
  }

  for (const relative of byRelative.keys()) {
    if (relative.endsWith(".yml") && !pointerPaths.has(relative)) {
      throw new Error(`release publish found unexpected updater pointer: ${relative}`);
    }
  }

  const summaryPaths = new Set(SUMMARY_ORDER);
  const phase = (relative) => {
    if (pointerPaths.has(relative)) return "pointer";
    if (summaryPaths.has(relative)) return "summary";
    return "payload";
  };
  const rank = { payload: 0, pointer: 1, summary: 2 };
  const summaryRank = new Map(SUMMARY_ORDER.map((name, index) => [name, index]));

  const plan = [];
  for (const [relative, source] of byRelative) {
    const info = await stat(source);
    plan.push({
      source,
      relative,
      key: `${STABLE_PREFIX}/${relative}`,
      phase: phase(relative),
      bytes: info.size,
      sha256: await sha256(source),
      cacheControl: phase(relative) === "payload" ? IMMUTABLE_CACHE : MUTABLE_CACHE,
      contentType: contentType(relative),
    });
  }
  plan.sort((left, right) => {
    const phaseDifference = rank[left.phase] - rank[right.phase];
    if (phaseDifference !== 0) return phaseDifference;
    if (left.phase === "summary") {
      return summaryRank.get(left.relative) - summaryRank.get(right.relative);
    }
    return left.relative.localeCompare(right.relative);
  });
  return plan;
}

function validateBucket(bucket) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? "")) {
    throw new Error("AWS_RELEASE_BUCKET is missing or invalid");
  }
}

function validateDistribution(distributionId) {
  if (distributionId && !/^[A-Z0-9]{8,32}$/.test(distributionId)) {
    throw new Error("AWS_RELEASE_CLOUDFRONT_DISTRIBUTION_ID is invalid");
  }
}

function aws(args, { allowNotFound = false } = {}) {
  const result = spawnSync("aws", args, { encoding: "utf8" });
  if (result.status === 0) return result.stdout;
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (allowNotFound && /(?:\(404\)|Not Found|NoSuchKey)/i.test(detail)) return null;
  throw new Error(`aws ${args[0]} failed: ${detail || `exit ${result.status}`}`);
}

function headObject(bucket, key, runAws = aws) {
  const output = runAws([
    "s3api", "head-object", "--bucket", bucket, "--key", key, "--output", "json",
  ], { allowNotFound: true });
  return output === null ? null : JSON.parse(output);
}

function upload(bucket, entry, runAws = aws) {
  const destination = `s3://${bucket}/${entry.key}`;
  const args = [
    "s3", "cp", entry.source, destination,
    "--only-show-errors",
    "--cache-control", entry.cacheControl,
    "--checksum-algorithm", "SHA256",
    "--metadata", `sha256=${entry.sha256}`,
  ];
  if (entry.contentType) args.push("--content-type", entry.contentType);
  runAws(args);

  const uploaded = headObject(bucket, entry.key, runAws);
  if (!uploaded || uploaded.ContentLength !== entry.bytes || uploaded.Metadata?.sha256 !== entry.sha256) {
    throw new Error(`uploaded object verification failed: ${entry.key}`);
  }
}

export function mutableInvalidationPaths(plan) {
  return plan.filter((entry) => entry.phase !== "payload").map((entry) => `/${entry.key}`);
}

export async function publishRelease({
  releaseRoot,
  bucket,
  distributionId = "",
  dryRun = false,
  runAws = aws,
}) {
  validateBucket(bucket);
  validateDistribution(distributionId);
  const plan = await planRelease(releaseRoot);
  if (dryRun) return plan;

  for (const entry of plan) {
    if (entry.phase === "payload") {
      const existing = headObject(bucket, entry.key, runAws);
      if (existing) {
        const same = existing.ContentLength === entry.bytes && existing.Metadata?.sha256 === entry.sha256;
        if (!same) throw new Error(`immutable release path conflict: ${entry.key}`);
        console.log(`release-publish: retained identical ${entry.key}`);
        continue;
      }
    }
    upload(bucket, entry, runAws);
    console.log(`release-publish: uploaded ${entry.phase} ${entry.key}`);
  }

  if (distributionId) {
    runAws([
      "cloudfront", "create-invalidation",
      "--distribution-id", distributionId,
      "--paths", ...mutableInvalidationPaths(plan),
    ]);
  }
  console.log(`release-publish: activated ${plan.length} files`);
  return plan;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const releaseRoot = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!releaseRoot) {
    console.error("usage: node publish-release.mjs <release-directory> [--dry-run]");
    process.exit(2);
  }
  try {
    const plan = await publishRelease({
      releaseRoot,
      bucket: process.env.AWS_RELEASE_BUCKET,
      distributionId: process.env.AWS_RELEASE_CLOUDFRONT_DISTRIBUTION_ID ?? "",
      dryRun,
    });
    if (dryRun) {
      for (const entry of plan) console.log(`${entry.phase}\t${entry.key}`);
    }
  } catch (error) {
    console.error(`release-publish: ${error.message}`);
    process.exit(1);
  }
}
