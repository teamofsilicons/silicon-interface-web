#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_RELEASE_ROOT = join(process.env.HOME ?? REPO_ROOT, ".silicon", "releases");
const LOCK_NAME = ".interface-production-deploy.lock";

const PRODUCTION = Object.freeze({
  apiBase: "https://glass.teamofsilicons.com",
  alias: "interface.teamofsilicons.com",
  projectId: "prj_r0fx5aWniIim4fitY5UNbkAHVrRo",
  projectName: "silicon-interface",
  orgId: "team_ZrYtbDUJ1TnXyeNBf7TB2Vln",
  scope: "saketdev12-5675s-projects",
  wsBase: "wss://glass.teamofsilicons.com",
});

const USAGE = `usage:
  bash scripts/deploy-production.sh --dry-run [--release-root PATH]
  bash scripts/deploy-production.sh --confirm-production [--release-root PATH]

--dry-run             Freeze and verify the exact source without touching Vercel.
--confirm-production  Run all gates, deploy, and promote interface.teamofsilicons.com.
--release-root PATH   Override the private evidence directory (mainly for testing).
--help                Show this help.`;

class DeployError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "DeployError";
  }
}

class ConcurrentAliasChangeError extends DeployError {
  constructor(message) {
    super(message);
    this.name = "ConcurrentAliasChangeError";
  }
}

export function parseArgs(argv) {
  const result = {
    confirmProduction: false,
    dryRun: false,
    help: false,
    releaseRoot: DEFAULT_RELEASE_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--confirm-production") {
      result.confirmProduction = true;
    } else if (value === "--dry-run") {
      result.dryRun = true;
    } else if (value === "--help" || value === "-h") {
      result.help = true;
    } else if (value === "--release-root") {
      index += 1;
      if (!argv[index]) throw new DeployError("--release-root requires a path");
      result.releaseRoot = resolve(argv[index]);
    } else if (value.startsWith("--release-root=")) {
      const path = value.slice("--release-root=".length);
      if (!path) throw new DeployError("--release-root requires a path");
      result.releaseRoot = resolve(path);
    } else {
      throw new DeployError(`unknown argument: ${value}`);
    }
  }
  if (result.help) return result;
  if (result.confirmProduction === result.dryRun) {
    throw new DeployError("choose exactly one of --dry-run or --confirm-production");
  }
  return result;
}

function shellDisplay(command, args) {
  const values = [command, ...args].map((value) => {
    const safe = String(value);
    return /^[A-Za-z0-9_./:=@-]+$/.test(safe) ? safe : JSON.stringify(safe);
  });
  return values.join(" ");
}

async function runCommand(command, args, options = {}) {
  const {
    capture = false,
    cwd = REPO_ROOT,
    env = process.env,
    label,
    quietStdout = false,
  } = options;
  if (label) console.log(`\n==> ${label}`);
  if (process.env.SILICON_DEPLOY_TRACE === "1") {
    console.log(`+ ${shellDisplay(command, args)}`);
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (capture) stdout += chunk;
      if (!quietStdout) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (capture) stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      rejectPromise(new DeployError(`could not run ${command}`, { cause: error }));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const suffix = signal ? ` (signal ${signal})` : ` (exit ${code ?? "unknown"})`;
      rejectPromise(new DeployError(`command failed${suffix}: ${shellDisplay(command, args)}`));
    });
  });
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(path) {
  return sha256(await readFile(path));
}

async function atomicJson(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const SERVICE_WORKER_RELEASE_PLACEHOLDER = "__SILICON_INTERFACE_RELEASE_ID__";

export function stampServiceWorker(source, releaseId) {
  const occurrences = source.split(SERVICE_WORKER_RELEASE_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new DeployError(
      `service worker must contain exactly one release placeholder (found ${occurrences})`,
    );
  }
  if (!/^interface-[A-Za-z0-9-]+$/.test(releaseId)) {
    throw new DeployError("service worker release id is invalid");
  }
  return source.replace(SERVICE_WORKER_RELEASE_PLACEHOLDER, releaseId);
}

function parseJsonOutput(raw, label) {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // Fall through to the intentionally content-free error below.
      }
    }
  }
  throw new DeployError(`${label} did not return valid JSON`);
}

function findString(value, keys) {
  if (!value || typeof value !== "object") return undefined;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findString(child, keys);
    if (found) return found;
  }
  return undefined;
}

function normalizeUrl(value) {
  if (!value) return undefined;
  return value.startsWith("http://") || value.startsWith("https://")
    ? value
    : `https://${value}`;
}

export function deploymentFromJson(value) {
  const id = findString(value, ["id", "deploymentId", "deployment_id"]);
  const url = normalizeUrl(findString(value, ["url", "deploymentUrl", "deployment_url"]));
  return { id, url };
}

export function verifyInspect(value, expected = {}) {
  if (!value || typeof value !== "object") throw new DeployError("Vercel inspect response is empty");
  if (value.readyState !== "READY") {
    throw new DeployError(`deployment is not READY (state ${String(value.readyState)})`);
  }
  if (value.target !== "production") {
    throw new DeployError(`deployment target is not production (target ${String(value.target)})`);
  }
  if (value.name !== PRODUCTION.projectName) {
    throw new DeployError(`deployment belongs to unexpected project ${String(value.name)}`);
  }
  if (expected.id && value.id !== expected.id) {
    throw new DeployError(`deployment identity mismatch: expected ${expected.id}, got ${String(value.id)}`);
  }
  if (expected.url) {
    const inspected = normalizeUrl(value.url);
    if (inspected !== normalizeUrl(expected.url)) {
      throw new DeployError("deployment URL does not match the CLI candidate");
    }
  }
  return {
    id: value.id,
    name: value.name,
    readyState: value.readyState,
    target: value.target,
    url: normalizeUrl(value.url),
  };
}

function headerValue(headers, name) {
  const match = headers.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim();
}

export function verifyHttpSmoke({ body, headers, status }) {
  if (String(status) !== "200") throw new DeployError(`HTTP smoke returned ${String(status)}`);
  if (!body.includes("self.__next_f")) throw new DeployError("HTTP smoke did not return a Next.js document");
  if (body.includes("integrity=")) throw new DeployError("HTTP smoke contains unsupported integrity attributes");
  const csp = headerValue(headers, "content-security-policy");
  if (!csp || !csp.includes("object-src 'none'") || csp.includes("'unsafe-eval'")) {
    throw new DeployError("HTTP smoke returned an unexpected content security policy");
  }
  const hsts = headerValue(headers, "strict-transport-security");
  if (!hsts?.toLowerCase().includes("max-age=")) throw new DeployError("HTTP smoke is missing HSTS");
  if (headerValue(headers, "x-content-type-options")?.toLowerCase() !== "nosniff") {
    throw new DeployError("HTTP smoke is missing X-Content-Type-Options");
  }
  if (headerValue(headers, "x-frame-options")?.toUpperCase() !== "DENY") {
    throw new DeployError("HTTP smoke is missing X-Frame-Options: DENY");
  }
  return {
    body_sha256: sha256(body),
    csp: "passed",
    hsts: "passed",
    next_bootstrap_frames: body.match(/self\.__next_f/g)?.length ?? 0,
    status: 200,
  };
}

export function suspiciousSourcePath(path) {
  const lower = path.toLowerCase();
  const base = lower.split("/").at(-1) ?? lower;
  if (lower === ".vercel" || lower.startsWith(".vercel/")) return true;
  if (base === ".env" || (base.startsWith(".env.") && !/\.(example|sample|template)$/.test(base))) return true;
  if (/^(id_rsa|id_ed25519|credentials)$/.test(base)) return true;
  if (/\.(pem|p12|pfx|key)$/.test(base)) return true;
  return false;
}

async function scanFrozenSource(context, manifest) {
  const suspiciousPaths = manifest.files.filter((entry) => suspiciousSourcePath(entry.path));
  if (suspiciousPaths.length > 0) {
    throw new DeployError(`release contains ${suspiciousPaths.length} credential-like path(s)`);
  }
  const signaturePatterns = [
    new RegExp(["-----BEGIN ", "[A-Z ]*PRIVATE KEY-----"].join("")),
    new RegExp(["A", "KIA[0-9A-Z]{16}"].join("")),
    new RegExp(["VERCEL_", "TOKEN\\s*=\\s*[^\\s$<{][^\\s]*"].join(""), "i"),
    new RegExp(["AWS_SECRET_", "ACCESS_KEY\\s*=\\s*[^\\s$<{][^\\s]*"].join(""), "i"),
  ];
  let matches = 0;
  for (const entry of manifest.files) {
    if (entry.size > 5 * 1024 * 1024) continue;
    const data = await readFile(join(context, entry.path));
    if (data.includes(0)) continue;
    const text = data.toString("utf8");
    if (signaturePatterns.some((pattern) => pattern.test(text))) matches += 1;
  }
  if (matches > 0) throw new DeployError(`release contains ${matches} high-risk credential signature(s)`);
  return { credential_signatures: 0, suspicious_paths: 0 };
}

async function validateProjectLink() {
  const path = join(REPO_ROOT, ".vercel", "project.json");
  let project;
  try {
    project = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new DeployError("frontend is not linked to the production Vercel project", { cause: error });
  }
  if (
    project.projectId !== PRODUCTION.projectId ||
    project.orgId !== PRODUCTION.orgId ||
    project.projectName !== PRODUCTION.projectName
  ) {
    throw new DeployError(".vercel/project.json does not match the approved production project");
  }
  return project;
}

async function acquireLock(releaseRoot) {
  await mkdir(releaseRoot, { recursive: true, mode: 0o700 });
  const lock = join(releaseRoot, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await atomicJson(join(lock, "owner.json"), {
        pid: process.pid,
        started_at: new Date().toISOString(),
      });
      return lock;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
      } catch {
        const lockStat = await stat(lock);
        if (Date.now() - lockStat.mtimeMs < 30_000) {
          throw new DeployError("another frontend production deploy is starting");
        }
      }
      let ownerAlive = false;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
          ownerAlive = true;
        } catch (signalError) {
          if (signalError?.code !== "ESRCH") ownerAlive = true;
        }
      }
      if (ownerAlive) throw new DeployError("another frontend production deploy is active");
      await rm(lock, { recursive: true, force: true });
    }
  }
  throw new DeployError("could not recover the stale frontend deploy lock");
}

async function inspectDeployment(reference, context, label = "Inspecting Vercel deployment") {
  const result = await runCommand(
    "pnpm",
    [
      "exec",
      "vercel",
      "inspect",
      reference,
      "--scope",
      PRODUCTION.scope,
      "--cwd",
      context,
      "--format=json",
    ],
    { capture: true, label, quietStdout: true },
  );
  return parseJsonOutput(result.stdout, "Vercel inspect");
}

async function promote(reference, context, label = "Promoting exact Vercel deployment") {
  await runCommand(
    "pnpm",
    [
      "exec",
      "vercel",
      "promote",
      reference,
      "--yes",
      "--timeout",
      "3m",
      "--scope",
      PRODUCTION.scope,
      "--cwd",
      context,
    ],
    { label },
  );
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

export function assertAliasIdentity(value, expectedId, phase = "production alias") {
  if (!value || value.id !== expectedId) {
    throw new DeployError(
      `${phase} changed concurrently: expected ${expectedId}, got ${String(value?.id)}`,
    );
  }
}

async function promoteOnceAndProveStable(deploymentId, allowedPriorId, context, labels = {}) {
  const {
    initial = "Promoting exact deployment",
  } = labels;
  await promote(deploymentId, context, initial);
  let matched = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await inspectDeployment(
      `https://${PRODUCTION.alias}`,
      context,
      `Verifying production alias (${attempt + 1}/8)`,
    );
    verifyInspect(current);
    if (current.id === deploymentId) {
      matched = true;
      break;
    }
    if (current.id !== allowedPriorId) {
      throw new ConcurrentAliasChangeError(
        `production alias moved to concurrent deployment ${current.id}; refusing to overwrite it`,
      );
    }
    await sleep(2_000);
  }
  if (!matched) throw new DeployError("production alias promotion did not become visible in time");

  for (let check = 0; check < 4; check += 1) {
    const current = await inspectDeployment(
      `https://${PRODUCTION.alias}`,
      context,
      `Checking alias stability (${check + 1}/4)`,
    );
    verifyInspect(current);
    if (current.id !== deploymentId) {
      throw new ConcurrentAliasChangeError(
        `production alias moved to concurrent deployment ${current.id}; refusing to overwrite it`,
      );
    }
    if (check < 3) await sleep(3_000);
  }
}

export function rollbackDecision(currentId, candidateId, previousId) {
  if (currentId === candidateId) return "rollback";
  if (currentId === previousId) return "already-previous";
  return "preserve-concurrent";
}

async function smokeWithVercel(deploymentId, context, releaseDir) {
  const bodyPath = join(releaseDir, ".immutable-smoke-body.html");
  const headersPath = join(releaseDir, "immutable-smoke-headers.txt");
  const result = await runCommand(
    "pnpm",
    [
      "exec",
      "vercel",
      "curl",
      "/auth/register",
      "--deployment",
      deploymentId,
      "--scope",
      PRODUCTION.scope,
      "--cwd",
      context,
      "--",
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--connect-timeout",
      "10",
      "--max-time",
      "45",
      "--output",
      bodyPath,
      "--dump-header",
      headersPath,
      "--write-out",
      "%{http_code}\\n",
    ],
    { capture: true, label: "Smoke-testing immutable deployment", quietStdout: true },
  );
  const status = result.stdout.match(/\b(\d{3})\b\s*$/)?.[1];
  const body = await readFile(bodyPath, "utf8");
  const headers = await readFile(headersPath, "utf8");
  const verified = verifyHttpSmoke({ body, headers, status });
  await rm(bodyPath, { force: true });
  return verified;
}

async function smokePublic(releaseDir) {
  const bodyPath = join(releaseDir, ".public-smoke-body.html");
  const headersPath = join(releaseDir, "public-smoke-headers.txt");
  const result = await runCommand(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--connect-timeout",
      "10",
      "--max-time",
      "45",
      "--output",
      bodyPath,
      "--dump-header",
      headersPath,
      "--write-out",
      "%{http_code}\\n",
      `https://${PRODUCTION.alias}/auth/register`,
    ],
    { capture: true, label: "Smoke-testing public production alias", quietStdout: true },
  );
  const status = result.stdout.match(/\b(\d{3})\b\s*$/)?.[1];
  const body = await readFile(bodyPath, "utf8");
  const headers = await readFile(headersPath, "utf8");
  const verified = verifyHttpSmoke({ body, headers, status });
  await rm(bodyPath, { force: true });
  return verified;
}

export function reliabilityCounts(output) {
  const passed = [...output.matchAll(/^(?:#|ℹ)\s+pass\s+(\d+)$/gm)].at(-1)?.[1];
  const failed = [...output.matchAll(/^(?:#|ℹ)\s+fail\s+(\d+)$/gm)].at(-1)?.[1];
  return {
    failed: failed === undefined ? 0 : Number(failed),
    passed: passed === undefined ? null : Number(passed),
  };
}

async function toolVersion(command, args) {
  const result = await runCommand(command, args, { capture: true, quietStdout: true });
  return result.stdout.trim().split("\n").at(-1);
}

async function treeContains(root, needle) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await treeContains(path, needle)) return true;
    } else if (entry.isFile()) {
      const info = await stat(path);
      if (info.size <= 20 * 1024 * 1024 && (await readFile(path)).includes(Buffer.from(needle))) {
        return true;
      }
    }
  }
  return false;
}

async function removeDirectoriesNamed(root, name) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.name === name && (entry.isDirectory() || entry.isSymbolicLink())) {
      await rm(path, { recursive: true, force: true });
    } else if (entry.isDirectory()) {
      await removeDirectoriesNamed(path, name);
    }
  }
}

async function validateToolchain(projectLink) {
  const packageJson = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
  if (packageJson.packageManager !== "pnpm@10.33.0") {
    throw new DeployError("packageManager must be pinned to pnpm@10.33.0");
  }
  const pnpm = await toolVersion("pnpm", ["--version"]);
  if (pnpm !== "10.33.0") {
    throw new DeployError(`pnpm 10.33.0 is required (found ${String(pnpm)})`);
  }
  if (projectLink.settings?.nodeVersion !== "24.x") {
    throw new DeployError("the Vercel project must remain pinned to Node 24.x");
  }
  const localNodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeParity = localNodeMajor === 24 ? "exact-major" : "remote-build-required";
  if (nodeParity !== "exact-major") {
    console.warn(
      `WARNING: local Node ${process.version} differs from production Node 24.x; ` +
        "the Vercel Node 24 remote build remains mandatory before promotion.",
    );
  }
  return { local_node_parity: nodeParity, node: process.version, pnpm };
}

async function freeze(archive, manifest) {
  const result = await runCommand(
    "python3",
    [
      join(SCRIPT_DIR, "freeze-source.py"),
      "--root",
      REPO_ROOT,
      "--archive",
      archive,
      "--manifest",
      manifest,
    ],
    { capture: true, label: "Freezing exact frontend source", quietStdout: true },
  );
  return parseJsonOutput(result.stdout, "source freezer");
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const projectLink = await validateProjectLink();
  const toolchain = await validateToolchain(projectLink);
  const lock = await acquireLock(args.releaseRoot);
  let temporaryDir;
  let releaseDir;
  let evidence;
  let evidencePath;
  let deployContext;
  let previousDeploymentId;
  let candidateId;
  let activeStep = "initializing";

  try {
    temporaryDir = await mkdtemp(join(args.releaseRoot, ".interface-freeze-"));
    const temporaryArchive = join(temporaryDir, "source.tar.gz");
    const temporaryManifest = join(temporaryDir, "source-manifest.json");
    activeStep = "freezing source";
    const freezeResult = await freeze(temporaryArchive, temporaryManifest);
    const sourceManifest = JSON.parse(await readFile(temporaryManifest, "utf8"));
    const releaseId = `interface-${compactTimestamp()}-${freezeResult.source_sha256.slice(0, 12)}`;
    releaseDir = join(args.releaseRoot, releaseId);
    try {
      await stat(releaseDir);
      throw new DeployError(`release directory already exists: ${releaseDir}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(temporaryDir, releaseDir);
    temporaryDir = undefined;

    const archive = join(releaseDir, "source.tar.gz");
    const manifestPath = join(releaseDir, "source-manifest.json");
    deployContext = join(releaseDir, "deploy-context");
    await mkdir(deployContext, { mode: 0o700 });
    await runCommand("tar", ["-xzf", archive, "-C", deployContext], {
      label: "Materializing immutable deploy context",
    });
    const embeddedManifest = await readFile(join(deployContext, ".silicon-source-manifest.json"));
    const externalManifest = await readFile(manifestPath);
    if (!embeddedManifest.equals(externalManifest)) {
      throw new DeployError("embedded source manifest does not match the external manifest");
    }
    // Browsers only install a replacement worker when /sw.js changes byte for
    // byte. Stamp the immutable release id into the deploy context so every
    // promoted application bundle activates one matching worker and reloads
    // already-open tabs exactly once. The frozen source remains unchanged;
    // this deterministic generated artifact is recorded in release evidence.
    const serviceWorkerPath = join(deployContext, "public", "sw.js");
    const serviceWorker = stampServiceWorker(
      await readFile(serviceWorkerPath, "utf8"),
      releaseId,
    );
    await writeFile(serviceWorkerPath, serviceWorker, { mode: 0o644 });
    activeStep = "scanning frozen source";
    const secretScan = await scanFrozenSource(deployContext, sourceManifest);
    const gitStatus = await runCommand("git", ["status", "--porcelain=v1", "-z"], {
      capture: true,
      quietStdout: true,
    });
    const statusEntries = gitStatus.stdout.split("\0").filter(Boolean);
    const lockEntry = sourceManifest.files.find((entry) => entry.path === "pnpm-lock.yaml");

    evidence = {
      schema: 1,
      release_id: releaseId,
      status: "frozen",
      dry_run: args.dryRun,
      source_sha256: freezeResult.source_sha256,
      archive_sha256: freezeResult.archive_sha256,
      manifest_sha256: await sha256File(manifestPath),
      pnpm_lock_sha256: lockEntry?.sha256 ?? null,
      file_count: freezeResult.file_count,
      git_head: sourceManifest.git_head,
      git_tree: sourceManifest.git_tree,
      working_tree: {
        dirty: statusEntries.length > 0,
        status_entry_count: statusEntries.length,
        status_sha256: sha256(gitStatus.stdout),
      },
      production: {
        api_base: PRODUCTION.apiBase,
        alias: PRODUCTION.alias,
        project_id: PRODUCTION.projectId,
        project_name: PRODUCTION.projectName,
        org_id: PRODUCTION.orgId,
        scope: PRODUCTION.scope,
        ws_base: PRODUCTION.wsBase,
      },
      validation: {
        frozen_source: "passed",
        secret_scan: "passed",
        secret_scan_details: secretScan,
        service_worker_release_stamp: "passed",
      },
      service_worker: {
        release_id: releaseId,
        sha256: sha256(serviceWorker),
      },
      created_at: new Date().toISOString(),
      toolchain,
    };
    evidencePath = join(releaseDir, "deployment-evidence.json");
    await atomicJson(evidencePath, evidence);

    activeStep = "installing frozen dependencies";
    await runCommand("pnpm", ["install", "--frozen-lockfile"], {
      cwd: deployContext,
      label: "Installing frozen dependencies",
    });
    evidence.validation.install = "passed";
    await atomicJson(evidencePath, evidence);

    activeStep = "running reliability tests";
    const reliability = await runCommand("pnpm", ["test:reliability"], {
      capture: true,
      cwd: deployContext,
      label: "Running reliability suite",
    });
    const counts = reliabilityCounts(reliability.stdout);
    if (counts.failed !== 0 || counts.passed === null || counts.passed < 1) {
      throw new DeployError("reliability suite did not report a complete passing summary");
    }
    evidence.validation.reliability_failed = counts.failed;
    evidence.validation.reliability_passed = counts.passed;

    activeStep = "running lint";
    await runCommand("pnpm", ["lint"], { cwd: deployContext, label: "Running ESLint" });
    evidence.validation.lint = "passed";

    activeStep = "running typecheck";
    await runCommand("pnpm", ["exec", "tsc", "--noEmit"], {
      cwd: deployContext,
      label: "Running TypeScript check",
    });
    evidence.validation.typecheck = "passed";

    activeStep = "running local production build";
    await runCommand("pnpm", ["build"], {
      cwd: deployContext,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_BASE: PRODUCTION.apiBase,
        NEXT_PUBLIC_WS_BASE: PRODUCTION.wsBase,
      },
      label: "Building frozen production source",
    });
    if (
      !(await treeContains(join(deployContext, ".next"), PRODUCTION.apiBase)) ||
      !(await treeContains(join(deployContext, ".next"), PRODUCTION.wsBase))
    ) {
      throw new DeployError("local production bundle is not bound to the approved Glass endpoints");
    }
    evidence.validation.production_endpoint_binding = "passed";
    evidence.validation.production_build_local = "passed";
    evidence.tool_versions = {
      node: process.version,
      pnpm: await toolVersion("pnpm", ["--version"]),
      vercel: await toolVersion("pnpm", ["exec", "vercel", "--version"]),
    };
    await atomicJson(evidencePath, evidence);

    // Generated dependencies and build output are never part of the release
    // artifact or Vercel upload. The cloud rebuilds from the frozen lockfile.
    await removeDirectoriesNamed(deployContext, "node_modules");
    await rm(join(deployContext, ".next"), { recursive: true, force: true });
    await rm(join(deployContext, "next-env.d.ts"), { force: true });
    await rm(join(deployContext, "tsconfig.tsbuildinfo"), { force: true });

    // The checkout must still freeze to the same bytes after every local gate.
    // This prevents a concurrent editor or Git operation from making the
    // operator believe a newer working tree is the one about to ship.
    activeStep = "rechecking deterministic source identity";
    const recheckDir = await mkdtemp(join(args.releaseRoot, ".interface-recheck-"));
    try {
      const secondArchive = join(recheckDir, "source.tar.gz");
      const secondManifest = join(recheckDir, "source-manifest.json");
      await freeze(secondArchive, secondManifest);
      if (
        (await sha256File(secondArchive)) !== freezeResult.archive_sha256 ||
        (await sha256File(secondManifest)) !== evidence.manifest_sha256
      ) {
        throw new DeployError("source changed after it was frozen; start the deploy again");
      }
      evidence.validation.source_recheck = "byte-identical";
      await atomicJson(evidencePath, evidence);
    } finally {
      await rm(recheckDir, { recursive: true, force: true });
    }

    if (args.dryRun) {
      evidence.status = "dry-run-complete";
      evidence.completed_at = new Date().toISOString();
      await atomicJson(evidencePath, evidence);
      console.log(`\nDry run passed. Frozen release: ${releaseDir}`);
      console.log("All local production gates passed; Vercel and the production alias were not changed.");
      return 0;
    }

    activeStep = "linking immutable deploy context";
    await mkdir(join(deployContext, ".vercel"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(deployContext, ".vercel", "project.json"),
      `${JSON.stringify(projectLink, null, 2)}\n`,
      { mode: 0o600 },
    );
    await runCommand("pnpm", ["exec", "vercel", "whoami", "--scope", PRODUCTION.scope], {
      capture: true,
      label: "Checking Vercel authentication",
      quietStdout: true,
    });

    activeStep = "recording current production deployment";
    const previous = await inspectDeployment(
      `https://${PRODUCTION.alias}`,
      deployContext,
      "Recording rollback deployment",
    );
    verifyInspect(previous);
    previousDeploymentId = previous.id;
    evidence.previous_deployment = {
      id: previous.id,
      url: normalizeUrl(previous.url),
    };
    await atomicJson(evidencePath, evidence);

    activeStep = "deploying immutable candidate";
    const deployResult = await runCommand(
      "pnpm",
      [
        "exec",
        "vercel",
        "deploy",
        "--prod",
        "--skip-domain",
        "--force",
        "--yes",
        "--format=json",
        "--scope",
        PRODUCTION.scope,
        "--cwd",
        deployContext,
        "--build-env",
        `NEXT_PUBLIC_API_BASE=${PRODUCTION.apiBase}`,
        "--build-env",
        `NEXT_PUBLIC_WS_BASE=${PRODUCTION.wsBase}`,
        "--meta",
        `siliconReleaseId=${evidence.release_id}`,
        "--meta",
        `siliconSourceSha256=${evidence.source_sha256}`,
      ],
      { capture: true, label: "Deploying production-target candidate", quietStdout: true },
    );
    const cliCandidate = deploymentFromJson(parseJsonOutput(deployResult.stdout, "Vercel deploy"));
    if (!cliCandidate.id && !cliCandidate.url) {
      throw new DeployError("Vercel deploy did not return a deployment identity");
    }

    activeStep = "verifying immutable candidate";
    const candidateInspect = await inspectDeployment(
      cliCandidate.id ?? cliCandidate.url,
      deployContext,
      "Verifying immutable candidate",
    );
    const candidate = verifyInspect(candidateInspect, cliCandidate);
    candidateId = candidate.id;
    evidence.deployment = {
      id: candidate.id,
      project_id: PRODUCTION.projectId,
      promoted: false,
      ready_state: candidate.readyState,
      source: "cli-frozen-archive",
      target: candidate.target,
      url: candidate.url,
    };
    evidence.validation.production_build_remote = "passed";
    const postDeployAlias = await inspectDeployment(
      `https://${PRODUCTION.alias}`,
      deployContext,
      "Confirming --skip-domain preserved production",
    );
    assertAliasIdentity(postDeployAlias, previousDeploymentId, "production alias after candidate deploy");
    evidence.validation.immutable_http_smoke = await smokeWithVercel(
      candidate.id,
      deployContext,
      releaseDir,
    );
    await atomicJson(evidencePath, evidence);

    activeStep = "promoting and stabilizing production alias";
    const prePromotionAlias = await inspectDeployment(
      `https://${PRODUCTION.alias}`,
      deployContext,
      "Confirming production did not change during candidate validation",
    );
    assertAliasIdentity(prePromotionAlias, previousDeploymentId, "production alias before promotion");
    await promoteOnceAndProveStable(candidate.id, previousDeploymentId, deployContext, {
      initial: "Promoting exact candidate",
    });

    activeStep = "verifying public production";
    evidence.validation.public_http_smoke = await smokePublic(releaseDir);
    const finalAlias = await inspectDeployment(
      `https://${PRODUCTION.alias}`,
      deployContext,
      "Final production identity check",
    );
    verifyInspect(finalAlias, { id: candidate.id });
    evidence.aliases_after_promotion = {
      [PRODUCTION.alias]: finalAlias.id,
    };
    evidence.deployment.promoted = true;
    evidence.status = "deployed";
    evidence.completed_at = new Date().toISOString();
    await atomicJson(evidencePath, evidence);

    console.log(`\nProduction deploy completed: https://${PRODUCTION.alias}`);
    console.log(`Deployment: ${candidate.id}`);
    console.log(`Evidence: ${evidencePath}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown deployment failure";
    // `vercel deploy --skip-domain` has moved aliases unexpectedly in the past.
    // Once both identities are known, always inspect and apply the same CAS
    // rollback decision—even if the explicit promote step was never reached.
    if (previousDeploymentId && candidateId && previousDeploymentId !== candidateId && deployContext) {
      try {
        const current = await inspectDeployment(
          `https://${PRODUCTION.alias}`,
          deployContext,
          "Determining safe rollback action",
        );
        const decision = rollbackDecision(current.id, candidateId, previousDeploymentId);
        if (decision === "rollback") {
          await promoteOnceAndProveStable(previousDeploymentId, candidateId, deployContext, {
            initial: "Failure detected; rolling back production alias",
          });
          if (evidence) evidence.rollback = { id: previousDeploymentId, status: "passed" };
        } else if (decision === "already-previous") {
          if (evidence) evidence.rollback = { id: previousDeploymentId, status: "already-restored" };
        } else {
          if (evidence) {
            evidence.rollback = {
              concurrent_deployment_id: current.id,
              status: "preserved-concurrent-deployment",
            };
          }
          console.error(
            `Production moved to concurrent deployment ${current.id}; it was not overwritten.`,
          );
        }
      } catch (rollbackError) {
        if (evidence) {
          evidence.rollback = {
            error: rollbackError instanceof Error ? rollbackError.message : "unknown rollback failure",
            id: previousDeploymentId,
            status: "failed",
          };
        }
        console.error("CRITICAL: automatic production alias rollback failed.");
      }
    }
    if (evidence && evidencePath) {
      evidence.status = "failed";
      evidence.failed_at = new Date().toISOString();
      evidence.failure = { message, step: activeStep };
      await atomicJson(evidencePath, evidence).catch(() => {});
      console.error(`Evidence: ${evidencePath}`);
    }
    throw error;
  } finally {
    if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

const isDirect = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirect) {
  main().catch((error) => {
    console.error(`deploy refused: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
