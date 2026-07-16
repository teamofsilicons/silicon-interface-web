import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AUDIT_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const SEVERITY = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parsePnpmLockPackages(contents) {
  const packages = new Map();
  let insidePackages = false;
  let foundPackages = false;
  for (const line of contents.split(/\r?\n/)) {
    if (line === "packages:") {
      insidePackages = true;
      foundPackages = true;
      continue;
    }
    if (insidePackages && /^[A-Za-z][^:]*:$/.test(line)) break;
    if (!insidePackages) continue;

    const match = line.match(/^  (.+):$/);
    if (!match) continue;
    const locator = unquote(match[1]).replace(/\(.*/, "");
    const versionAt = locator.lastIndexOf("@");
    if (versionAt <= 0) continue;
    const name = locator.slice(0, versionAt);
    const version = locator.slice(versionAt + 1);
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) continue;
    if (!packages.has(name)) packages.set(name, new Set());
    packages.get(name).add(version);
  }
  if (!foundPackages || packages.size === 0) {
    throw new Error("dependency-audit: pnpm lockfile has no package inventory");
  }
  return Object.fromEntries(
    [...packages].sort(([left], [right]) => left.localeCompare(right)).map(([name, versions]) => [
      name,
      [...versions].sort(),
    ]),
  );
}

export function flattenAdvisories(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("dependency-audit: registry returned an invalid advisory document");
  }
  const rows = [];
  for (const [module, advisories] of Object.entries(response)) {
    if (!Array.isArray(advisories)) {
      throw new Error(`dependency-audit: registry returned invalid advisories for ${module}`);
    }
    for (const advisory of advisories) {
      if (!advisory || typeof advisory !== "object" || !SEVERITY.has(advisory.severity)) {
        throw new Error(`dependency-audit: registry returned an invalid advisory for ${module}`);
      }
      rows.push({
        module,
        severity: advisory.severity,
        title: String(advisory.title ?? "Untitled advisory"),
        url: String(advisory.url ?? ""),
        vulnerableVersions: String(advisory.vulnerable_versions ?? "unknown"),
      });
    }
  }
  return rows.sort((left, right) => {
    const severity = SEVERITY.get(right.severity) - SEVERITY.get(left.severity);
    return severity || left.module.localeCompare(right.module) || left.title.localeCompare(right.title);
  });
}

export function blocksRelease(advisory, threshold = "high") {
  if (!SEVERITY.has(threshold)) throw new Error(`dependency-audit: invalid threshold ${threshold}`);
  return SEVERITY.get(advisory.severity) >= SEVERITY.get(threshold);
}

async function requestAdvisories(packages, fetchImpl = fetch) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(AUDIT_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(packages),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(`registry returned HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      }
      return flattenAdvisories(await response.json());
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw new Error(`dependency-audit: advisory query failed after 3 attempts: ${lastError?.message}`);
}

export async function auditLockfile({
  lockfile = "pnpm-lock.yaml",
  threshold = process.env.SILICON_AUDIT_LEVEL ?? "high",
  fetchImpl = fetch,
} = {}) {
  const packages = parsePnpmLockPackages(await readFile(lockfile, "utf8"));
  const advisories = await requestAdvisories(packages, fetchImpl);
  const blocking = advisories.filter((advisory) => blocksRelease(advisory, threshold));
  return { packages: Object.keys(packages).length, advisories, blocking, threshold };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const result = await auditLockfile({ lockfile: process.argv[2] ?? "pnpm-lock.yaml" });
    for (const advisory of result.advisories) {
      console.error(
        `${advisory.severity.toUpperCase()} ${advisory.module}: ${advisory.title} ` +
          `(${advisory.vulnerableVersions})${advisory.url ? ` ${advisory.url}` : ""}`,
      );
    }
    if (result.blocking.length > 0) {
      throw new Error(
        `${result.blocking.length} advisories meet the ${result.threshold} release threshold`,
      );
    }
    console.log(
      `dependency-audit: PASS (${result.packages} locked packages, ` +
        `${result.advisories.length} advisories, threshold ${result.threshold})`,
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
