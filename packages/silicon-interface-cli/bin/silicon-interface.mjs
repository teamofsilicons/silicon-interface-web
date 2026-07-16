#!/usr/bin/env node

import fs, { createReadStream, createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_API_BASE = "http://127.0.0.1:8000";
const CONFIG_DIR = path.join(
  process.env.SILICON_INTERFACE_HOME || path.join(os.homedir(), ".silicon-interface"),
);
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const VERSION = "2.0.0";
const CHAT_PROTOCOL = 1;
const PING_INTERVAL_MS = 25_000;
const PING_TIMEOUT_MS = 62_500;
const MAX_RECONNECT_MS = 15_000;
const MAX_BUFFERED_FRAMES = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_MAX_RETRIES = 4;
const MEDIA_SEND_MAX_RETRIES = 60;
const MEDIA_SEND_RETRY_TIMEOUT_MS = 60_000;
const MEDIA_SEND_DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 86_400_000;
const STREAM_STATE_VERSION = 2;
const OPERATION_JOURNAL_VERSION = 1;

class UsageError extends Error {}

class ApiError extends Error {
  constructor(status, body, message, retryAfterMs = null) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

class TransportError extends Error {
  constructor(message, cause = null) {
    super(message, cause ? { cause } : undefined);
  }
}

class ProtocolError extends Error {}
class SyncIntegrityError extends Error {}

function cleanBase(value) {
  return String(value || "").replace(/\/$/, "");
}

function deriveWsBase(apiBase) {
  return cleanBase(apiBase).replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function atomicWriteJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.renameSync(tempPath, filePath);
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
  } finally {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best effort cleanup after an interrupted rename.
    }
  }
}

function writeConfig(config) {
  atomicWriteJson(CONFIG_PATH, config);
}

function interfaceRoot() {
  return path.resolve(process.env.SILICON_INTERFACE_ROOT || process.cwd());
}

function stateDir(root = interfaceRoot()) {
  return path.join(root, ".silicon-interface");
}

function statePath() {
  return process.env.SILICON_INTERFACE_STATE || path.join(stateDir(), "state.json");
}

function inboxPath() {
  return process.env.SILICON_INTERFACE_INBOX || path.join(stateDir(), "inbox.jsonl");
}

function operationsPath() {
  return path.join(stateDir(), "operations.json");
}

function pidPath(root = interfaceRoot()) {
  return path.join(stateDir(root), "daemon.pid");
}

function logPath(kind = "log", root = interfaceRoot()) {
  return path.join(stateDir(root), `daemon.${kind}`);
}

function readState() {
  const data = readJsonFile(statePath());
  return data && typeof data === "object" ? data : {};
}

function lockIsStale(lockPath) {
  if (Date.now() - fs.statSync(lockPath).mtimeMs <= 30_000) return false;
  const owner = Number(fs.readFileSync(lockPath, "utf8").trim());
  if (!Number.isSafeInteger(owner) || owner <= 0) return true;
  try {
    process.kill(owner, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

function withFileLock(targetPath, fn) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const lockPath = `${targetPath}.lock`;
  let descriptor;
  for (let attemptIndex = 0; attemptIndex < 500; attemptIndex += 1) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (lockIsStale(lockPath)) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      globalThis.Atomics.wait(
        new globalThis.Int32Array(new globalThis.SharedArrayBuffer(4)),
        0,
        0,
        10,
      );
    }
  }
  if (descriptor == null) throw new TransportError(`Timed out locking ${targetPath}.`);
  try {
    return fn();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

async function withAsyncFileLock(targetPath, fn) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const lockPath = `${targetPath}.lock`;
  let descriptor;
  for (let attemptIndex = 0; attemptIndex < 1_200; attemptIndex += 1) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (lockIsStale(lockPath)) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await sleep(25);
    }
  }
  if (descriptor == null) throw new TransportError(`Timed out locking ${targetPath}.`);
  try {
    return await fn();
  } finally {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
  }
}

function updateState(mutator) {
  return withFileLock(statePath(), () => {
    const next = mutator(readState());
    atomicWriteJson(statePath(), next);
    return next;
  });
}

const inboxDedupeCache = { path: "", size: 0, keys: new Set() };

function rebuildInboxDedupe(filePath) {
  const keys = new Set();
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    text = "";
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try {
      const value = JSON.parse(line);
      const identity = frameIdentity(value);
      if (identity) keys.add(`${value._inbox_context || "legacy"}:${identity}`);
    } catch {
      // Preserve malformed crash remnants, but do not count them as durable frames.
    }
  }
  while (keys.size > 250_000) keys.delete(keys.values().next().value);
  inboxDedupeCache.path = filePath;
  inboxDedupeCache.size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  inboxDedupeCache.keys = keys;
}

function inboxEndsWithNewline(filePath, size) {
  if (!size) return true;
  const descriptor = fs.openSync(filePath, "r");
  const last = Buffer.allocUnsafe(1);
  try {
    fs.readSync(descriptor, last, 0, 1, size - 1);
  } finally {
    fs.closeSync(descriptor);
  }
  return last[0] === 0x0a;
}

function appendInbox(frame, context) {
  const filePath = inboxPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  return withFileLock(filePath, () => {
    const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (inboxDedupeCache.path !== filePath || inboxDedupeCache.size !== size) {
      rebuildInboxDedupe(filePath);
    }
    const identity = frameIdentity(frame);
    const key = identity ? `${context}:${identity}` : "";
    if (key && inboxDedupeCache.keys.has(key)) return false;
    if (!inboxEndsWithNewline(filePath, size)) {
      fs.appendFileSync(filePath, "\n", { mode: 0o600 });
      inboxDedupeCache.size += 1;
    }
    const stored = { ...frame, _inbox_context: context };
    const line = `${JSON.stringify(stored)}\n`;
    fs.appendFileSync(filePath, line, { mode: 0o600 });
    inboxDedupeCache.size += Buffer.byteLength(line);
    if (key) {
      inboxDedupeCache.keys.add(key);
      if (inboxDedupeCache.keys.size > 250_000) {
        inboxDedupeCache.keys.delete(inboxDedupeCache.keys.values().next().value);
      }
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best effort on filesystems without POSIX modes.
    }
    return true;
  });
}

function sha256Text(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function streamStateKey(ctx) {
  const authKind = ctx.config.siliconKey ? "silicon" : "carbon";
  // Access tokens rotate. Prefer stable principal/device material so a refresh
  // cannot strand a valid durable sync checkpoint under a new key.
  const credential =
    (authKind === "silicon" ? ctx.config.detectedSiliconUsername : "") ||
    ctx.config.siliconKey ||
    ctx.config.deviceId ||
    ctx.config.refreshToken ||
    ctx.config.accessToken ||
    "anonymous";
  return sha256Text(
    `${ctx.config.apiBase}\0${authKind}\0${credential}\0${ctx.syncScope || "all"}`,
  ).slice(0, 32);
}

function inboxContextKey(ctx) {
  const authKind = ctx.config.siliconKey ? "silicon" : "carbon";
  const credential =
    (authKind === "silicon" ? ctx.config.detectedSiliconUsername : "") ||
    ctx.config.siliconKey ||
    ctx.config.deviceId ||
    ctx.config.refreshToken ||
    ctx.config.accessToken ||
    "anonymous";
  return sha256Text(`${ctx.config.apiBase}\0${authKind}\0${credential}`).slice(0, 32);
}

function emptyStreamCheckpoint(ctx) {
  return {
    apiBase: ctx.config.apiBase,
    event: "",
    account: "",
    eventPosition: 0,
    eventVector: { floor: 0, writers: {} },
    accountPosition: 0,
    bootstrapped: false,
    updatedAt: "",
  };
}

function readStreamCheckpoint(ctx) {
  const state = readState();
  if (state.version !== STREAM_STATE_VERSION || !state.streams || typeof state.streams !== "object") {
    return emptyStreamCheckpoint(ctx);
  }
  const stored = state.streams[streamStateKey(ctx)];
  if (!stored || typeof stored !== "object" || stored.apiBase !== ctx.config.apiBase) {
    return emptyStreamCheckpoint(ctx);
  }
  return { ...emptyStreamCheckpoint(ctx), ...stored };
}

function writeStreamCheckpoint(ctx, checkpoint, pendingDeliveryIds = []) {
  updateState((current) => {
    const state =
      current.version === STREAM_STATE_VERSION && current.streams && typeof current.streams === "object"
        ? current
        : { version: STREAM_STATE_VERSION, streams: {} };
    const key = streamStateKey(ctx);
    state.streams[key] = {
      ...emptyStreamCheckpoint(ctx),
      ...checkpoint,
      apiBase: ctx.config.apiBase,
      updatedAt: new Date().toISOString(),
    };
    if (pendingDeliveryIds.length) {
      state.pendingDeliveries ||= {};
      state.pendingDeliveries[key] = [
        ...new Set([...(state.pendingDeliveries[key] || []), ...pendingDeliveryIds.filter(Boolean)]),
      ].slice(-5_000);
    }
    return state;
  });
}

function pendingDeliveryIds(ctx) {
  const state = readState();
  return state.version === STREAM_STATE_VERSION
    ? state.pendingDeliveries?.[streamStateKey(ctx)] || []
    : [];
}

function removePendingDeliveryIds(ctx, removed) {
  updateState((state) => {
    if (state.version !== STREAM_STATE_VERSION || !state.pendingDeliveries) return state;
    const key = streamStateKey(ctx);
    const removedSet = new Set(removed);
    state.pendingDeliveries[key] = (state.pendingDeliveries[key] || []).filter(
      (eventId) => !removedSet.has(eventId),
    );
    if (!state.pendingDeliveries[key].length) delete state.pendingDeliveries[key];
    return state;
  });
}

function resetStreamCheckpoint(ctx) {
  updateState((state) => {
    if (state.version === STREAM_STATE_VERSION && state.streams) {
      delete state.streams[streamStateKey(ctx)];
    }
    return state;
  });
}

function operationSignature(kind, value) {
  return sha256Text(`${kind}\0${JSON.stringify(value)}`);
}

function readOperationJournal() {
  const value = readJsonFile(operationsPath());
  if (!value || value.version !== OPERATION_JOURNAL_VERSION || !Array.isArray(value.operations)) {
    return { version: OPERATION_JOURNAL_VERSION, operations: [] };
  }
  return value;
}

function writeOperationJournal(journal) {
  journal.operations = journal.operations
    .filter((row) => row && typeof row === "object")
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, 500);
  atomicWriteJson(operationsPath(), journal);
}

function updateOperationJournal(mutator) {
  return withFileLock(operationsPath(), () => {
    const journal = readOperationJournal();
    const result = mutator(journal);
    writeOperationJournal(journal);
    return result;
  });
}

function beginOperation(ctx, kind, value) {
  const signature = operationSignature(kind, value);
  const context = streamStateKey(ctx);
  return updateOperationJournal((journal) => {
    const existing = journal.operations.find(
      (row) => row.context === context && row.signature === signature && row.status === "pending",
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    const row = {
      context,
      signature,
      kind,
      intent: value,
      clientId: `cli_${randomUUID().replaceAll("-", "")}`,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    journal.operations.push(row);
    return row;
  });
}

function finishOperation(operation, result = {}) {
  updateOperationJournal((journal) => {
    const row = journal.operations.find(
      (candidate) =>
        candidate.context === operation.context &&
        candidate.signature === operation.signature &&
        candidate.clientId === operation.clientId,
    );
    if (!row) return;
    row.status = "complete";
    row.result = result;
    row.updatedAt = new Date().toISOString();
  });
}

function updateOperation(operation, patch) {
  const row = updateOperationJournal((journal) => {
    const found = journal.operations.find(
      (candidate) =>
        candidate.context === operation.context &&
        candidate.signature === operation.signature &&
        candidate.clientId === operation.clientId,
    );
    if (!found) return null;
    Object.assign(found, patch, { updatedAt: new Date().toISOString() });
    return found;
  });
  if (row) Object.assign(operation, row);
  return operation;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findUp(fileName, startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

function readSimpleToml(filePath) {
  try {
    const out = {};
    for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("[")) continue;
      const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
      if (!match) continue;
      let value = match[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[match[1]] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function loadGlassConfig(startDir = process.env.SILICON_INTERFACE_ROOT || process.cwd()) {
  let glassPath = "";
  const resolved = path.resolve(startDir);
  if (path.basename(resolved) === ".glass.json" && fs.existsSync(resolved)) {
    glassPath = resolved;
  } else {
    glassPath = findUp(".glass.json", resolved);
  }
  if (!glassPath) return {};
  const data = readJsonFile(glassPath);
  if (!data || typeof data !== "object") return {};
  const apiBase = data.server_url || "";
  const siliconKey = data.api_key || data.silicon_api_key || "";
  return {
    apiBase,
    wsBase: data.ws_url || (apiBase ? deriveWsBase(apiBase) : ""),
    siliconKey,
    siliconUsername: data.silicon_username || "",
    source: glassPath,
  };
}

function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function copyPackage(targetDir) {
  const src = packageRoot();
  const dest = path.join(targetDir, ".silicon-interface", "package");
  fs.rmSync(dest, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(src, source);
      if (!relative) return true;
      const parts = relative.split(path.sep);
      return !parts.includes("node_modules") && !parts.includes(".silicon-interface");
    },
  });
  return dest;
}

function writeShim(targetDir, name) {
  const binDir = path.join(targetDir, ".silicon-interface", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, name);
  const shim = `#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$HERE/../.." && pwd)
export SILICON_INTERFACE_ROOT="$ROOT"
exec node "$ROOT/.silicon-interface/package/bin/silicon-interface.mjs" "$@"
`;
  fs.writeFileSync(shimPath, shim, { mode: 0o755 });
  try {
    fs.chmodSync(shimPath, 0o755);
  } catch {
    // Best effort.
  }
  return shimPath;
}

function installInto(target) {
  const targetDir = path.resolve(target || ".");
  if (!fs.existsSync(targetDir)) throw new UsageError(`Target directory does not exist: ${targetDir}`);
  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) throw new UsageError(`Target is not a directory: ${targetDir}`);
  const installedPackage = copyPackage(targetDir);
  const siliconInterface = writeShim(targetDir, "silicon-interface");
  const si = writeShim(targetDir, "si");
  return {
    target: targetDir,
    package: installedPackage,
    binDir: path.dirname(si),
    commands: { "silicon-interface": siliconInterface, si },
    glassDetected: Boolean(findUp(".glass.json", targetDir)),
  };
}

function loadLegacySiliconChatConfig() {
  const configured = process.env.SILICON_CHAT_CREDS;
  const credsPath = configured || path.join(os.homedir(), ".silicon-chat", "credentials.toml");
  const data = readSimpleToml(credsPath);
  if (!Object.keys(data).length) return {};
  return {
    apiBase: data.endpoint || "",
    siliconKey: data.api_key || "",
    defaultSilicon: data.default_silicon || "",
    source: credsPath,
  };
}

function parseGlobalArgs(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--api" || arg === "--api-base") {
      flags.apiBase = argv[++i];
    } else if (arg.startsWith("--api=")) {
      flags.apiBase = arg.slice("--api=".length);
    } else if (arg.startsWith("--api-base=")) {
      flags.apiBase = arg.slice("--api-base=".length);
    } else if (arg === "--ws" || arg === "--ws-base") {
      flags.wsBase = argv[++i];
    } else if (arg.startsWith("--ws=")) {
      flags.wsBase = arg.slice("--ws=".length);
    } else if (arg.startsWith("--ws-base=")) {
      flags.wsBase = arg.slice("--ws-base=".length);
    } else if (arg === "--key" || arg === "--silicon-key") {
      flags.siliconKey = argv[++i];
    } else if (arg.startsWith("--key=")) {
      flags.siliconKey = arg.slice("--key=".length);
    } else if (arg.startsWith("--silicon-key=")) {
      flags.siliconKey = arg.slice("--silicon-key=".length);
    } else if (arg === "--access-token") {
      flags.accessToken = argv[++i];
    } else if (arg.startsWith("--access-token=")) {
      flags.accessToken = arg.slice("--access-token=".length);
    } else if (arg === "--device-id") {
      flags.deviceId = argv[++i];
    } else if (arg.startsWith("--device-id=")) {
      flags.deviceId = arg.slice("--device-id=".length);
    } else if (arg === "--timeout") {
      flags.requestTimeout = argv[++i];
    } else if (arg.startsWith("--timeout=")) {
      flags.requestTimeout = arg.slice("--timeout=".length);
    } else if (arg === "--json") {
      flags.json = true;
    } else if (arg === "--jsonl") {
      flags.jsonl = true;
    } else if (arg === "--no-color") {
      flags.noColor = true;
    } else {
      args.push(arg);
    }
  }
  return { flags, args };
}

function resolveRuntimeConfig(flags) {
  const fileConfig = readConfig();
  const glassConfig = loadGlassConfig();
  const legacyConfig = loadLegacySiliconChatConfig();
  const apiBase = cleanBase(
    flags.apiBase ||
      process.env.SILICON_INTERFACE_API_BASE ||
      process.env.NEXT_PUBLIC_API_BASE ||
      glassConfig.apiBase ||
      fileConfig.apiBase ||
      legacyConfig.apiBase ||
      DEFAULT_API_BASE,
  );
  return {
    apiBase,
    wsBase: cleanBase(
      flags.wsBase ||
        process.env.SILICON_INTERFACE_WS_BASE ||
        process.env.NEXT_PUBLIC_WS_BASE ||
        glassConfig.wsBase ||
        fileConfig.wsBase ||
        legacyConfig.wsBase ||
        deriveWsBase(apiBase),
    ),
    siliconKey:
      flags.siliconKey ||
      process.env.SILICON_INTERFACE_KEY ||
      process.env.SILICON_KEY ||
      glassConfig.siliconKey ||
      fileConfig.siliconKey ||
      legacyConfig.siliconKey ||
      "",
    accessToken:
      flags.accessToken ||
      process.env.SILICON_INTERFACE_ACCESS_TOKEN ||
      fileConfig.accessToken ||
      "",
    refreshToken:
      process.env.SILICON_INTERFACE_REFRESH_TOKEN || fileConfig.refreshToken || "",
    deviceId:
      flags.deviceId || process.env.SILICON_INTERFACE_DEVICE_ID || fileConfig.deviceId || "",
    requestTimeout: numberOption(
      flags.requestTimeout || process.env.SILICON_INTERFACE_TIMEOUT_MS || fileConfig.requestTimeout,
      REQUEST_TIMEOUT_MS,
      { min: 1_000, max: 300_000 },
    ),
    defaultRoom: fileConfig.defaultRoom || "",
    detectedGlassPath: glassConfig.source || "",
    detectedSiliconUsername: glassConfig.siliconUsername || "",
    legacyConfigPath: legacyConfig.source || "",
    json: Boolean(flags.json),
    jsonl: Boolean(flags.jsonl),
    color: !flags.noColor && process.stdout.isTTY,
  };
}

function setOption(options, key, value) {
  if (Object.hasOwn(options, key)) {
    options[key] = Array.isArray(options[key]) ? [...options[key], value] : [options[key], value];
  } else {
    options[key] = value;
  }
}

function camelFlag(name) {
  return name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function parseOptions(args, booleanKeys = []) {
  const booleans = new Set(booleanKeys);
  const options = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const rawKey = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const key = camelFlag(rawKey);
    if (eq >= 0) {
      setOption(options, key, arg.slice(eq + 1));
    } else if (booleans.has(key)) {
      setOption(options, key, true);
    } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
      setOption(options, key, args[++i]);
    } else {
      setOption(options, key, true);
    }
  }
  return { options, positionals };
}

function asArray(value) {
  if (value == null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  if (value == null) return undefined;
  const text = String(value).toLowerCase();
  if (["1", "true", "yes", "on", "active"].includes(text)) return true;
  if (["0", "false", "no", "off", "inactive"].includes(text)) return false;
  throw new UsageError(`Expected a boolean, got '${value}'.`);
}

function parseJsonValue(value, label = "JSON") {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new UsageError(`${label} is invalid: ${error.message}`);
  }
}

function jsonBodyOption(options, { required = false } = {}) {
  let raw = options.data;
  if (options.dataFile) {
    raw = fs.readFileSync(path.resolve(String(options.dataFile)), "utf8");
  } else if (raw === "-") {
    raw = fs.readFileSync(0, "utf8");
  }
  const value = parseJsonValue(raw, "--data");
  if (required && value === undefined) throw new UsageError("Missing --data JSON.");
  return value;
}

function numberOption(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = Number(value ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(raw, max));
}

function integerValue(value, label, { min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new UsageError(`${label} must be an integer >= ${min}.`);
  }
  return parsed;
}

function requireAuth(ctx) {
  if (!ctx.config.siliconKey && !ctx.config.accessToken) {
    throw new UsageError(
      "No auth configured. Run inside a Glass-pulled silicon folder with .glass.json, pass SILICON_INTERFACE_KEY, or run `pnpm si auth set-key <key>`.",
    );
  }
}

function roomArg(ctx, value) {
  if (value && value !== ".") return value;
  if (ctx.config.defaultRoom) return ctx.config.defaultRoom;
  throw new UsageError("Missing room id. Pass a room id or set `config set defaultRoom <room_id>`.");
}

function bodyText(event) {
  const content = event?.content || {};
  if (event?.redacted_at) return "[redacted]";
  if (typeof content.body === "string") return content.body;
  if (event?.type === "m.album") {
    const count = Array.isArray(event.media_items)
      ? event.media_items.length
      : Array.isArray(content.items)
        ? content.items.length
        : 0;
    return `[album: ${count} attachment(s)]${content.caption ? ` ${content.caption}` : ""}`;
  }
  if (content.media_id) {
    const label = [event.type, content.filename, content.media_id].filter(Boolean).join(" ");
    return `[${label}]${content.caption ? ` ${content.caption}` : ""}`;
  }
  if (typeof content.caption === "string") return content.caption;
  if (typeof content.transcript === "string") return content.transcript;
  if (typeof content.summary === "string") return content.summary;
  return JSON.stringify(content);
}

function shortTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function printJson(value, compact = false) {
  console.log(JSON.stringify(value, null, compact ? 0 : 2));
}

function printResult(ctx, value, renderHuman) {
  if (ctx.config.json) printJson(value);
  else if (ctx.config.jsonl) {
    const rows = Array.isArray(value) ? value : [value];
    for (const row of rows) printJson(row, true);
  }
  else renderHuman(value);
}

function runPython(scriptPath, args = [], cwd = process.cwd()) {
  const candidates = [
    process.env.SILICON_PYTHON,
    "python3",
    "python",
  ].filter(Boolean);
  const tried = [];
  for (const command of [...new Set(candidates)]) {
    const result = spawnSync(command, [scriptPath, ...args], {
      cwd,
      encoding: "utf8",
    });
    tried.push(command);
    if (result.error?.code === "ENOENT") continue;
    return { command, result, tried };
  }
  return {
    command: "",
    result: { status: 127, stdout: "", stderr: `No Python executable found. Tried: ${tried.join(", ")}` },
    tried,
  };
}

function printRows(rows, columns) {
  const widths = columns.map((col) =>
    Math.max(
      col.label.length,
      ...rows.map((row) => String(col.value(row) ?? "").replace(/\s+/g, " ").length),
    ),
  );
  console.log(columns.map((col, i) => col.label.padEnd(widths[i])).join("  "));
  console.log(columns.map((_, i) => "-".repeat(widths[i])).join("  "));
  for (const row of rows) {
    console.log(
      columns
        .map((col, i) => String(col.value(row) ?? "").replace(/\s+/g, " ").padEnd(widths[i]))
        .join("  "),
    );
  }
}

function eventLine(event, roomId = "") {
  const sender = event.sender_handle || event.sender_kind || "system";
  const prefix = roomId ? `${roomId} ` : "";
  return `${prefix}${shortTime(event.created_at)} ${sender}: ${bodyText(event)}`;
}

function frameLine(frame) {
  if (frame.type === "hello") return `hello protocol=${frame.protocol_version || "?"} rooms=${frame.subscribed_rooms?.length || 0}`;
  if (frame.type === "pong") return "pong";
  if (frame.type === "initial.snapshot") return `initial snapshot ${frame.rooms?.length || 0} room(s)`;
  if (frame.type === "account.state") {
    return `account ${frame.position || "live"} ${frame.kind || "state"} ${frame.room_id || frame.object_id || ""}`.trim();
  }
  if (frame.type === "event") return eventLine(frame.event, frame.room_id);
  if (frame.type === "event.delta") return `${frame.room_id} delta ${frame.event_id}: ${frame.delta}`;
  if (frame.type === "event.final") return `${frame.room_id} final ${frame.event_id}`;
  if (frame.type === "event.transcript") return `${frame.room_id} transcript ${frame.event_id}: ${frame.transcript}`;
  if (frame.type === "read_receipt") return `${frame.room_id} read ${frame.event_id}`;
  if (frame.type === "delivery_receipt") return `${frame.room_id} delivered ${(frame.event_ids || []).join(",")}`;
  if (frame.type === "thread_read_receipt") return `${frame.room_id} thread read ${frame.event_id || ""}`;
  if (frame.type === "take_back") return `${frame.room_id} take_back ${frame.event_ids.join(",")}`;
  if (frame.type === "take_back_request") {
    const request = frame.request || {};
    return `${request.room_id || ""} take_back_request ${request.request_id || ""} ${request.message_count || 0} message(s)`;
  }
  if (frame.type === "progress") {
    const parts = [frame.room_id, frame.kind || frame.state || "progress"];
    if (frame.member_handle) parts.push(`@${frame.member_handle}`);
    if (frame.note) parts.push(frame.note);
    return parts.join(" ");
  }
  if (frame.type === "room.added") return `room.added ${frame.room_id} ${frame.kind}`;
  if (frame.type === "room.updated") return `room.updated ${frame.room_id}`;
  if (frame.type === "room.removed") return `room.removed ${frame.room_id}`;
  return JSON.stringify(frame);
}

function joinUrl(base, pathName) {
  return `${cleanBase(base)}${pathName.startsWith("/") ? pathName : `/${pathName}`}`;
}

function responseRetryAfterMs(response, body) {
  const header = response.headers.get("retry-after");
  const failure =
    body && typeof body === "object" && body.failure && typeof body.failure === "object"
      ? body.failure
      : null;
  const bodySeconds =
    body && typeof body === "object" && "retry_after_seconds" in body
      ? Number(body.retry_after_seconds)
      : failure
        ? Number(failure.retry_after_seconds)
        : Number.NaN;
  const seconds = header != null ? Number(header) : bodySeconds;
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  if (header) {
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
    }
  }
  return null;
}

async function request(ctx, method, pathName, body, options = {}) {
  return requestWithOptions(ctx, method, pathName, body, options);
}

function newTraceparent() {
  return `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;
}

function protocolHeaders(response) {
  const numericHeader = (name) => {
    const value = response.headers.get(name);
    return value == null || value === "" ? Number.NaN : Number(value);
  };
  const current = numericHeader("x-chat-protocol");
  const minimum = numericHeader("x-chat-protocol-min");
  const maximum = numericHeader("x-chat-protocol-max");
  return { current, minimum, maximum };
}

function validateProtocolResponse(response) {
  const { current, minimum, maximum } = protocolHeaders(response);
  if (
    Number.isFinite(minimum) &&
    Number.isFinite(maximum) &&
    (CHAT_PROTOCOL < minimum || CHAT_PROTOCOL > maximum)
  ) {
    throw new ProtocolError(
      `Glass supports chat protocol ${minimum}-${maximum}; this CLI speaks ${CHAT_PROTOCOL}.`,
    );
  }
  return current;
}

function retryableApiError(error) {
  if (!(error instanceof ApiError)) return false;
  const failure =
    error.body && typeof error.body === "object" && error.body.failure &&
    typeof error.body.failure === "object"
      ? error.body.failure
      : null;
  if (failure?.automatic === true && failure?.retryable === true) return true;
  return [429, 502, 503, 504].includes(error.status);
}

function retryDelay(attemptIndex, requested = null) {
  const base = Math.min(500 * 2 ** attemptIndex, MAX_RECONNECT_MS);
  const bounded = requested == null ? base : Math.min(Math.max(0, requested), MAX_RECONNECT_MS);
  return Math.round(bounded * (0.5 + Math.random()));
}

function persistRefreshedTokens(ctx, payload) {
  if (!payload?.access) return false;
  ctx.config.accessToken = payload.access;
  if (payload.refresh) ctx.config.refreshToken = payload.refresh;
  withFileLock(CONFIG_PATH, () => {
    const fileConfig = readConfig();
    if (!fileConfig.accessToken && !fileConfig.refreshToken) return;
    fileConfig.accessToken = payload.access;
    if (payload.refresh) fileConfig.refreshToken = payload.refresh;
    atomicWriteJson(CONFIG_PATH, fileConfig);
  });
  return true;
}

async function refreshAccessToken(ctx) {
  if (ctx.config.siliconKey || !ctx.config.refreshToken) return false;
  const observedRefresh = ctx.config.refreshToken;
  return withAsyncFileLock(`${CONFIG_PATH}.refresh`, async () => {
    const latest = readConfig();
    if (
      latest.refreshToken &&
      latest.refreshToken !== observedRefresh &&
      latest.accessToken
    ) {
      ctx.config.accessToken = latest.accessToken;
      ctx.config.refreshToken = latest.refreshToken;
      if (latest.deviceId) ctx.config.deviceId = latest.deviceId;
      return true;
    }
    try {
      const refreshToken = latest.refreshToken || observedRefresh;
      const payload = await requestWithOptions(
        ctx,
        "POST",
        "/api/v1/auth/refresh",
        { refresh: refreshToken },
        { auth: false, retries: 1, allowRefresh: false, idempotent: true },
      );
      return persistRefreshedTokens(ctx, payload);
    } catch {
      return false;
    }
  });
}

async function requestWithOptions(
  ctx,
  method,
  pathName,
  body,
  {
    auth = true,
    retries,
    idempotent = false,
    allowRefresh = true,
    signal,
    traceparent,
    headers: extraHeaders = {},
    bodyType = "json",
    responseType = "auto",
  } = {},
) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const safeMethod = ["GET", "HEAD", "OPTIONS", "DELETE"].includes(normalizedMethod);
  const maxRetries = Math.max(
    0,
    Number.isFinite(Number(retries))
      ? Number(retries)
      : safeMethod || idempotent
        ? REQUEST_MAX_RETRIES
        : 0,
  );
  const requestTrace = traceparent || newTraceparent();
  let refreshed = false;
  let lastError = null;
  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex += 1) {
    const headers = {
      Accept: "application/json",
      "X-Chat-Protocol": String(CHAT_PROTOCOL),
      "User-Agent": `silicon-interface-cli/${VERSION}`,
      traceparent: requestTrace,
      ...extraHeaders,
    };
    if (auth) {
      if (ctx.config.accessToken) headers.Authorization = `Bearer ${ctx.config.accessToken}`;
      if (ctx.config.siliconKey) headers["X-Silicon-Key"] = ctx.config.siliconKey;
      if (!ctx.config.siliconKey && ctx.config.deviceId) headers["X-Device-ID"] = ctx.config.deviceId;
    }
    const init = { method: normalizedMethod, headers };
    if (body !== undefined) {
      if (bodyType === "json") {
        headers["Content-Type"] = "application/json";
        init.body = typeof body === "string" ? body : JSON.stringify(body);
      } else if (bodyType === "form" || bodyType === "raw") {
        init.body = body;
      } else {
        throw new UsageError(`Unsupported request body type '${bodyType}'.`);
      }
    }
    const timeoutSignal = globalThis.AbortSignal.timeout(
      ctx.config.requestTimeout || REQUEST_TIMEOUT_MS,
    );
    init.signal = signal ? globalThis.AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetch(joinUrl(ctx.config.apiBase, pathName), init);
      validateProtocolResponse(response);
      const contentType = response.headers.get("content-type") || "";
      if (response.ok && responseType === "buffer") {
        return Buffer.from(await response.arrayBuffer());
      }
      if (response.ok && responseType === "text") return response.text();
      if (response.ok && responseType === "json") {
        return response.json().catch(() => {
          throw new ProtocolError(`${normalizedMethod} ${pathName} did not return valid JSON.`);
        });
      }
      const parsed = contentType.includes("application/json")
        ? await response.json().catch(() => null)
        : await response.text().catch(() => null);
      if (response.ok) return parsed;
      const detail =
        parsed && typeof parsed === "object" && "detail" in parsed ? parsed.detail : undefined;
      const error = new ApiError(
        response.status,
        parsed,
        detail || `${normalizedMethod} ${pathName} -> ${response.status}`,
        responseRetryAfterMs(response, parsed),
      );
      if (
        response.status === 401 &&
        auth &&
        allowRefresh &&
        !refreshed &&
        !ctx.config.siliconKey &&
        (await refreshAccessToken(ctx))
      ) {
        refreshed = true;
        attemptIndex -= 1;
        continue;
      }
      lastError = error;
      if (attemptIndex >= maxRetries || !retryableApiError(error)) throw error;
      await sleep(retryDelay(attemptIndex, error.retryAfterMs));
    } catch (error) {
      if (error instanceof ApiError || error instanceof ProtocolError) {
        if (error === lastError) throw error;
        lastError = error;
        if (attemptIndex >= maxRetries || !retryableApiError(error)) throw error;
      } else {
        const transport = new TransportError(
          error?.name === "TimeoutError"
            ? `${normalizedMethod} ${pathName} timed out.`
            : `${normalizedMethod} ${pathName} failed: ${error?.message || error}`,
          error,
        );
        lastError = transport;
        if (attemptIndex >= maxRetries || (!safeMethod && !idempotent)) throw transport;
      }
      await sleep(retryDelay(attemptIndex));
    }
  }
  throw lastError || new TransportError(`${normalizedMethod} ${pathName} failed.`);
}

async function attempt(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

const api = {
  healthz: (ctx) => request(ctx, "GET", "/healthz", undefined, { auth: false }),
  readyz: (ctx) => request(ctx, "GET", "/readyz", undefined, { auth: false }),
  version: (ctx) => request(ctx, "GET", "/api/v1/version", undefined, { auth: false }),
  loginStart: (ctx, identifier) =>
    requestWithOptions(ctx, "POST", "/api/v1/auth/login/start", { identifier }, { auth: false }),
  loginSelectChannel: (ctx, challengeId, channel) =>
    requestWithOptions(
      ctx,
      "POST",
      "/api/v1/auth/login/select-channel",
      { challenge_id: challengeId, channel },
      { auth: false },
    ),
  loginVerify: (ctx, challengeId, code) =>
    requestWithOptions(
      ctx,
      "POST",
      "/api/v1/auth/login/verify",
      { challenge_id: challengeId, code },
      { auth: false },
    ),
  registerEmailStart: (ctx, email, flowId = "") =>
    requestWithOptions(
      ctx,
      "POST",
      "/api/v1/auth/register/email/start",
      { email, ...(flowId ? { flow_id: flowId } : {}) },
      { auth: false },
    ),
  registerEmailVerify: (ctx, flowId, email, code) =>
    requestWithOptions(
      ctx,
      "POST",
      "/api/v1/auth/register/email/verify",
      { flow_id: flowId, email, code },
      { auth: false },
    ),
  registerPhoneStart: (ctx, phone, flowId) =>
    requestWithOptions(
      ctx,
      "POST",
      "/api/v1/auth/register/phone/start",
      { phone, flow_id: flowId },
      { auth: false },
    ),
  registerPhoneVerify: (ctx, flowId, phone, code) =>
    requestWithOptions(
      ctx,
      "POST",
      "/api/v1/auth/register/phone/verify",
      { flow_id: flowId, phone, code },
      { auth: false },
    ),
  registerUsername: (ctx, flowId, username) =>
    requestWithOptions(
      ctx,
      "POST",
      "/api/v1/auth/register/username",
      { flow_id: flowId, ...(username ? { username } : {}) },
      { auth: false },
    ),
  carbonIdAvailable: (ctx, value) =>
    requestWithOptions(
      ctx,
      "GET",
      `/api/v1/auth/carbon-id/available?value=${encodeURIComponent(value)}`,
      undefined,
      { auth: false },
    ),
  registerDevice: (ctx, payload) => request(ctx, "POST", "/api/v1/devices", payload),
  devices: (ctx) => request(ctx, "GET", "/api/v1/devices"),
  revokeDevice: (ctx, deviceId) =>
    request(ctx, "POST", `/api/v1/devices/${encodeURIComponent(deviceId)}/revoke`, {}),
  chatPreferences: (ctx) => request(ctx, "GET", "/api/v1/chat/preferences"),
  patchChatPreferences: (ctx, payload) =>
    request(ctx, "PATCH", "/api/v1/chat/preferences", payload),
  meSilicon: (ctx) => request(ctx, "GET", "/api/v1/silicons/me"),
  meCarbon: (ctx) => request(ctx, "GET", "/api/v1/carbons/me"),
  patchMeCarbon: (ctx, payload) => request(ctx, "PATCH", "/api/v1/carbons/me", payload),
  openSiliconBrowser: (ctx, siliconId) =>
    requestWithOptions(
      ctx,
      "POST",
      `/api/v1/silicons/${encodeURIComponent(siliconId)}/browser-session`,
      undefined,
      { idempotent: true },
    ),
  takeBackPolicy: (ctx) => request(ctx, "GET", "/api/v1/carbons/me/take-back-policy"),
  patchTakeBackPolicy: (ctx, payload) =>
    request(ctx, "PATCH", "/api/v1/carbons/me/take-back-policy", payload),
  teams: (ctx) => request(ctx, "GET", "/api/v1/teams/"),
  team: (ctx, slug) => request(ctx, "GET", `/api/v1/teams/${encodeURIComponent(slug)}/`),
  createTeam: (ctx, payload) => request(ctx, "POST", "/api/v1/teams/", payload),
  patchTeam: (ctx, slug, payload) =>
    request(ctx, "PATCH", `/api/v1/teams/${encodeURIComponent(slug)}/`, payload),
  uploadTeamLogo: (ctx, slug, filePath) => {
    const form = new globalThis.FormData();
    form.append(
      "file",
      new globalThis.Blob([fs.readFileSync(filePath)], { type: mimeFromPath(filePath) }),
      path.basename(filePath),
    );
    return requestWithOptions(
      ctx,
      "POST",
      `/api/v1/teams/${encodeURIComponent(slug)}/logo`,
      form,
      { bodyType: "form" },
    );
  },
  teamMembers: (ctx, slug) =>
    request(ctx, "GET", `/api/v1/teams/${encodeURIComponent(slug)}/members`),
  teamSilicons: (ctx, slug) =>
    request(ctx, "GET", `/api/v1/teams/${encodeURIComponent(slug)}/silicons`),
  teamReactivity: (ctx, slug) =>
    request(ctx, "GET", `/api/v1/teams/${encodeURIComponent(slug)}/reactivity`),
  teamReactivitySeries: (ctx, slug, bucket) =>
    request(
      ctx,
      "GET",
      `/api/v1/teams/${encodeURIComponent(slug)}/reactivity/series?bucket=${encodeURIComponent(bucket)}`,
    ),
  teamStructure: (ctx, slug) =>
    request(ctx, "GET", `/api/v1/teams/${encodeURIComponent(slug)}/structure`),
  teamInvites: (ctx, slug) =>
    request(ctx, "GET", `/api/v1/teams/${encodeURIComponent(slug)}/invites`),
  createTeamInvite: (ctx, slug, payload) =>
    request(ctx, "POST", `/api/v1/teams/${encodeURIComponent(slug)}/invites`, payload),
  disableTeamInvite: (ctx, slug, inviteId) =>
    request(
      ctx,
      "DELETE",
      `/api/v1/teams/${encodeURIComponent(slug)}/invites/${encodeURIComponent(inviteId)}`,
    ),
  teamInvitees: (ctx, slug, offset, limit) => {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    return request(
      ctx,
      "GET",
      `/api/v1/teams/${encodeURIComponent(slug)}/invitees?${query}`,
    );
  },
  invite: (ctx, token) =>
    request(ctx, "GET", `/api/v1/invites/${encodeURIComponent(token)}`),
  acceptInvite: (ctx, token, payload) =>
    request(ctx, "POST", `/api/v1/invites/${encodeURIComponent(token)}/accept`, payload),
  inviteVerifyEmailStart: (ctx, token, email) =>
    request(ctx, "POST", `/api/v1/invites/${encodeURIComponent(token)}/verify-email/start`, {
      email,
    }),
  inviteVerifyEmailCheck: (ctx, token, email, code) =>
    request(ctx, "POST", `/api/v1/invites/${encodeURIComponent(token)}/verify-email/check`, {
      email,
      code,
    }),
  teamBilling: (ctx, slug) =>
    request(ctx, "GET", `/api/v1/teams/${encodeURIComponent(slug)}/billing`),
  setTeamPlan: (ctx, slug, payload) =>
    request(ctx, "POST", `/api/v1/teams/${encodeURIComponent(slug)}/billing/plan`, payload),
  addTeamAddon: (ctx, slug, payload) =>
    request(ctx, "POST", `/api/v1/teams/${encodeURIComponent(slug)}/billing/addons`, payload),
  rollTeamCycle: (ctx, slug) =>
    request(ctx, "POST", `/api/v1/teams/${encodeURIComponent(slug)}/billing/roll`, {}),
  teamCheckout: (ctx, slug, payload) =>
    requestWithOptions(
      ctx,
      "POST",
      `/api/v1/teams/${encodeURIComponent(slug)}/billing/checkout`,
      payload,
      { idempotent: Boolean(payload?.idempotency_key) },
    ),
  rooms: (ctx) => request(ctx, "GET", "/api/v1/rooms/"),
  createRoom: (ctx, payload) => request(ctx, "POST", "/api/v1/rooms/", payload),
  room: (ctx, roomId) => request(ctx, "GET", `/api/v1/rooms/${encodeURIComponent(roomId)}/`),
  patchRoom: (ctx, roomId, payload) =>
    request(ctx, "PATCH", `/api/v1/rooms/${encodeURIComponent(roomId)}/`, payload),
  patchRoomListPreferences: (ctx, roomId, payload) =>
    request(
      ctx,
      "PATCH",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/list-preferences`,
      payload,
    ),
  members: (ctx, roomId) => request(ctx, "GET", `/api/v1/rooms/${encodeURIComponent(roomId)}/members`),
  addMember: (ctx, roomId, payload) =>
    request(ctx, "POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/members`, payload),
  historyPage: (ctx, roomId, { cursor = "", limit = 50, direction = "backward", anchor } = {}) => {
    const qs = new URLSearchParams({ cursor, limit: String(limit), direction });
    if (anchor) qs.set("anchor", anchor);
    return request(ctx, "GET", `/api/v1/rooms/${encodeURIComponent(roomId)}/events?${qs}`);
  },
  syncEventsCursor: (ctx, { cursor = "", through = "", limit = 200 } = {}) => {
    const qs = new URLSearchParams({ cursor, limit: String(limit) });
    if (through) qs.set("through", through);
    return request(ctx, "GET", `/api/v1/events/sync?${qs}`);
  },
  syncAccount: (ctx, { cursor = "", through = "", limit = 200 } = {}) => {
    const qs = new URLSearchParams({ cursor, limit: String(limit) });
    if (through) qs.set("through", through);
    return request(ctx, "GET", `/api/v1/sync/account?${qs}`);
  },
  acknowledgeDelivered: (ctx, eventIds) =>
    requestWithOptions(
      ctx,
      "POST",
      "/api/v1/events/delivered",
      { event_ids: eventIds },
      { idempotent: true },
    ),
  initialSync: (ctx, { cursor = "", limit = 100, timelineLimit = 50 } = {}) => {
    const qs = new URLSearchParams({
      limit: String(limit),
      timeline_limit: String(timelineLimit),
    });
    if (cursor) qs.set("cursor", cursor);
    return request(ctx, "GET", `/api/v1/sync/initial?${qs}`);
  },
  wsTicket: (ctx) =>
    requestWithOptions(ctx, "POST", "/api/v1/ws/ticket", {}, { idempotent: false }),
  directRoom: (ctx, kind, targetId) =>
    requestWithOptions(
      ctx,
      "POST",
      "/api/v1/rooms/direct",
      { target_kind: kind, target_id: targetId },
      { idempotent: true },
    ),
  sendEvent: (ctx, roomId, payload) =>
    requestWithOptions(
      ctx,
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/events`,
      payload,
      { idempotent: Boolean(payload?.content?.client_id) },
    ),
  clientOperation: (ctx, roomId, kind, clientId, includeResult = true) =>
    request(
      ctx,
      "GET",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/operations/${encodeURIComponent(kind)}/${encodeURIComponent(clientId)}${includeResult ? "?include=result" : ""}`,
    ),
  forwardEvents: (ctx, roomId, payload) =>
    request(ctx, "POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/forward`, payload),
  thread: (ctx, eventId, { cursor = "", limit = 50 } = {}) => {
    const qs = cursor
      ? new URLSearchParams({ cursor })
      : new URLSearchParams({ limit: String(limit) });
    return request(ctx, "GET", `/api/v1/events/${encodeURIComponent(eventId)}/thread?${qs}`);
  },
  threadRead: (ctx, eventId, throughEventId) =>
    request(
      ctx,
      "POST",
      `/api/v1/events/${encodeURIComponent(eventId)}/thread/read`,
      { event_id: throughEventId },
      { idempotent: true },
    ),
  editEvent: (ctx, eventId, payload) =>
    request(ctx, "POST", `/api/v1/events/${encodeURIComponent(eventId)}/edit`, payload),
  reaction: (ctx, eventId, payload) =>
    requestWithOptions(
      ctx,
      "PUT",
      `/api/v1/events/${encodeURIComponent(eventId)}/reaction`,
      payload,
      { idempotent: Boolean(payload?.client_id) },
    ),
  drafts: (ctx) => request(ctx, "GET", "/api/v1/drafts"),
  draft: (ctx, roomId) => request(ctx, "GET", `/api/v1/rooms/${encodeURIComponent(roomId)}/draft`),
  putDraft: (ctx, roomId, payload) =>
    request(ctx, "PUT", `/api/v1/rooms/${encodeURIComponent(roomId)}/draft`, payload),
  deleteDraft: (ctx, roomId, payload) =>
    request(ctx, "DELETE", `/api/v1/rooms/${encodeURIComponent(roomId)}/draft`, payload),
  heldSends: (ctx, roomId) =>
    request(ctx, "GET", `/api/v1/rooms/${encodeURIComponent(roomId)}/held-sends`),
  heldSendsAll: (ctx) => request(ctx, "GET", "/api/v1/held-sends"),
  createHeldSend: (ctx, roomId, payload) =>
    requestWithOptions(
      ctx,
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/held-sends`,
      payload,
      { idempotent: Boolean(payload?.client_id) },
    ),
  patchHeldSend: (ctx, roomId, heldId, payload) =>
    request(
      ctx,
      "PATCH",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/held-sends/${encodeURIComponent(heldId)}`,
      payload,
    ),
  deleteHeldSend: (ctx, roomId, heldId) =>
    request(
      ctx,
      "DELETE",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/held-sends/${encodeURIComponent(heldId)}`,
    ),
  sendHeldNow: (ctx, roomId, heldId) =>
    request(
      ctx,
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/held-sends/${encodeURIComponent(heldId)}/send-now`,
      {},
    ),
  read: (ctx, roomId, eventId) =>
    request(
      ctx,
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/read`,
      { event_id: eventId },
      { idempotent: true },
    ),
  typing: (ctx, roomId, active) =>
    request(
      ctx,
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/typing`,
      { is_typing: active },
      { idempotent: true },
    ),
  activity: (ctx, roomId, state, active) =>
    request(
      ctx,
      "POST",
      `/api/v1/rooms/${encodeURIComponent(roomId)}/activity`,
      { state, active },
      { idempotent: true },
    ),
  progress: (ctx, roomId, payload) =>
    request(ctx, "POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/progress`, payload),
  takeBack: (ctx, eventId, reason, force) =>
    request(ctx, "POST", `/api/v1/events/${encodeURIComponent(eventId)}/take_back`, {
      reason,
      force,
    }),
  takeBackRequests: (ctx, status = "pending") => {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    return request(ctx, "GET", `/api/v1/silicons/me/take-back-requests${qs.toString() ? `?${qs}` : ""}`);
  },
  completeTakeBackRequest: (ctx, requestId, payload) =>
    request(
      ctx,
      "POST",
      `/api/v1/silicons/me/take-back-requests/${encodeURIComponent(requestId)}/complete`,
      payload,
    ),
  deleteEvent: (ctx, eventId) =>
    request(ctx, "POST", `/api/v1/events/${encodeURIComponent(eventId)}/delete`, {}),
  reportMessage: (ctx, payload) =>
    requestWithOptions(ctx, "POST", "/api/v1/moderation/reports", payload, {
      idempotent: Boolean(payload?.client_id),
    }),
  moderationRestrictions: (ctx) => request(ctx, "GET", "/api/v1/moderation/restrictions"),
  moderationAppeals: (ctx) => request(ctx, "GET", "/api/v1/moderation/appeals"),
  submitModerationAppeal: (ctx, payload) =>
    request(ctx, "POST", "/api/v1/moderation/appeals", payload),
  appendDelta: (ctx, eventId, delta, seq) =>
    request(ctx, "POST", `/api/v1/events/${encodeURIComponent(eventId)}/delta`, { delta, seq }),
  finalizeEvent: (ctx, eventId) =>
    request(ctx, "POST", `/api/v1/events/${encodeURIComponent(eventId)}/final`, {}),
  carbonByHandle: (ctx, handle) =>
    request(ctx, "GET", `/api/v1/handle/carbon/${encodeURIComponent(handle)}`),
  siliconByHandle: (ctx, handle) =>
    request(ctx, "GET", `/api/v1/handle/silicon/${encodeURIComponent(handle)}`),
  crons: (ctx, params = {}) => {
    const qs = new URLSearchParams();
    if (params.for) qs.set("for", params.for);
    if (params.setupBy) qs.set("setup_by", params.setupBy);
    if (params.mine) qs.set("mine", "1");
    return request(ctx, "GET", `/api/v1/crons/${qs.toString() ? `?${qs}` : ""}`);
  },
  cron: (ctx, cronId) => request(ctx, "GET", `/api/v1/crons/${encodeURIComponent(cronId)}`),
  createCron: (ctx, payload) => request(ctx, "POST", "/api/v1/crons/", payload),
  patchCron: (ctx, cronId, payload) =>
    request(ctx, "PATCH", `/api/v1/crons/${encodeURIComponent(cronId)}`, payload),
  deleteCron: (ctx, cronId) =>
    request(ctx, "DELETE", `/api/v1/crons/${encodeURIComponent(cronId)}`),
  search: (ctx, params) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") qs.set(key, String(value));
    }
    return request(ctx, "GET", `/api/v1/events/search?${qs}`);
  },
  presignUpload: (ctx, payload) => request(ctx, "POST", "/api/v1/media/upload-url", payload),
  mediaComplete: (ctx, mediaId, meta = {}) =>
    request(ctx, "POST", `/api/v1/media/${encodeURIComponent(mediaId)}/complete`, meta),
  mediaDetail: (ctx, mediaId) =>
    request(ctx, "GET", `/api/v1/media/${encodeURIComponent(mediaId)}`),
  createMultipartUpload: (ctx, payload) =>
    requestWithOptions(ctx, "POST", "/api/v1/media/uploads", payload, { idempotent: true }),
  multipartUpload: (ctx, sessionId) =>
    request(ctx, "GET", `/api/v1/media/uploads/${encodeURIComponent(sessionId)}`),
  signMultipartParts: (ctx, sessionId, parts) =>
    request(
      ctx,
      "POST",
      `/api/v1/media/uploads/${encodeURIComponent(sessionId)}/parts`,
      { parts },
    ),
  completeMultipartUpload: (ctx, sessionId, payload) =>
    requestWithOptions(
      ctx,
      "POST",
      `/api/v1/media/uploads/${encodeURIComponent(sessionId)}/complete`,
      payload,
      { idempotent: true },
    ),
  cancelMultipartUpload: (ctx, sessionId) =>
    request(ctx, "DELETE", `/api/v1/media/uploads/${encodeURIComponent(sessionId)}`),
  tts: (ctx, payload) => request(ctx, "POST", "/api/v1/tts", payload),
  stt: (ctx, payload) => request(ctx, "POST", "/api/v1/stt", payload),
  sessions: (ctx) => request(ctx, "GET", "/api/v1/silicons/me/sessions"),
  sessionNew: (ctx, roomId, summary) =>
    request(ctx, "POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/sessions`, { summary }),
  sessionEnd: (ctx, sessionId, summary) =>
    request(ctx, "POST", `/api/v1/silicons/me/sessions/${encodeURIComponent(sessionId)}/end`, {
      summary,
    }),
  contacts: (ctx) => request(ctx, "GET", "/api/v1/contacts/"),
  saveContact: (ctx, payload) => request(ctx, "POST", "/api/v1/contacts/", payload),
  updateContact: (ctx, id, payload) =>
    request(ctx, "PATCH", `/api/v1/contacts/${encodeURIComponent(id)}`, payload),
  deleteContact: (ctx, id) => request(ctx, "DELETE", `/api/v1/contacts/${encodeURIComponent(id)}`),
  announcements: (ctx) => request(ctx, "GET", "/api/v1/announcements"),
  costSummary: (ctx) => request(ctx, "GET", "/api/v1/cost/summary"),
  costRecent: (ctx) => request(ctx, "GET", "/api/v1/cost/recent"),
  pushVapidKey: (ctx) => request(ctx, "GET", "/api/v1/push/vapid-key"),
  pushSubscribe: (ctx, payload) =>
    request(ctx, "POST", "/api/v1/push/subscribe", payload, { idempotent: true }),
  pushUnsubscribe: (ctx, endpoint) =>
    request(ctx, "POST", "/api/v1/push/unsubscribe", { endpoint }, { idempotent: true }),
  requestAbuseChallengePush: (ctx, token) =>
    request(ctx, "POST", "/api/v1/challenges/push", { token }),
  answerAbuseChallenge: (ctx, payload) => request(ctx, "PUT", "/api/v1/challenges", payload),
  raw: (ctx, method, pathName, body, options = {}) =>
    requestWithOptions(ctx, method, pathName, body, options),
};

async function resolveTarget(ctx, kind, value) {
  const endpoint = kind === "carbon" ? api.carbonByHandle : api.siliconByHandle;
  let raw;
  try {
    raw = await endpoint(ctx, value);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { kind, id: value, handle: value, raw: null };
    }
    throw error;
  }
  return {
    kind,
    id: kind === "carbon" ? raw.carbon_id : raw.silicon_id,
    handle: kind === "carbon" ? raw.username || raw.carbon_id : raw.name || raw.silicon_id,
    raw,
  };
}

function parseTargetToken(token) {
  const idx = token.indexOf(":");
  if (idx < 0) throw new UsageError(`Target must look like kind:id, got '${token}'.`);
  const kind = token.slice(0, idx);
  const id = token.slice(idx + 1);
  if (kind !== "carbon" && kind !== "silicon") {
    throw new UsageError(`Target kind must be 'carbon' or 'silicon', got '${kind}'.`);
  }
  if (!id) throw new UsageError("Target id cannot be empty.");
  return { kind, id };
}

async function normalizeTargets(ctx, rawTargets) {
  const out = [];
  for (const raw of rawTargets) {
    const target = parseTargetToken(raw);
    const resolved = await resolveTarget(ctx, target.kind, target.id);
    out.push({ kind: resolved.kind, id: resolved.id });
  }
  return out;
}

function printHelp() {
  console.log(`silicon-interface ${VERSION}

Usage:
  si [global-options] <command> [args]

Global options:
  --api <url>             Backend API base. Default: ${DEFAULT_API_BASE}
  --ws <url>              WebSocket base. Default: derived from API base.
  --key <key>             Silicon API key for this invocation.
  --access-token <token>  Carbon access token for this invocation.
  --device-id <id>        Stable Carbon device id.
  --timeout <ms>          REST timeout (1000-300000). Default: ${REQUEST_TIMEOUT_MS}.
  --json                  One machine-readable JSON value.
  --jsonl                 Stream one JSON value per line.

Setup:
  install [target] [--no-daemon]
                          Install locally and start the live inbox automatically.
  auth login <identity> [--no-daemon]
                          Log a Carbon in and start the live inbox automatically.
  auth register --email e --phone +... --username id [--email-code n --phone-code n]
  auth available <id>     Check Carbon ID validity and availability.
  auth status             Check the configured identity.
  auth import-glass [dir] [--no-daemon]
                          Import Glass auth and start the live inbox automatically.
  auth set-key [key] [--no-daemon]
                          Store a Silicon key and start the live inbox automatically.
  auth set-token <token> [--refresh token] [--device-id id] [--no-daemon]
  auth clear              Stop the live inbox and remove stored credentials.
  devices list|register|revoke
                          Manage Carbon installations and bound tokens.
  profile show|patch --data JSON
  preferences show|set [--read-receipts bool] [--presence value]
  config show             Show persisted config and detected Glass config.
  config set <key> <val>  apiBase, wsBase, siliconKey, accessToken,
                          refreshToken, deviceId, requestTimeout, defaultRoom.

Status:
  status                  Health, readiness, Glass version, identity, room count.
  me                      Show the current Carbon or Silicon.
  update check|trigger    Trigger this silicon's system update check now.

Rooms and messages:
  rooms list              List rooms.
  rooms show <room>       Show a room, its members, and recent events.
  rooms create <name...> [--topic text]
  rooms patch <room> [--name text] [--topic text]
  rooms members <room>
  rooms preferences <room> [--pinned bool] [--archived bool]
  rooms add-member <room> <kind> <numeric-member-id> [--role member]
  rooms direct <kind> <handle-or-id>
  messages recent <room> [--limit 50] [--cursor token]
  messages history <room> [--max n] [--output file.json|file.jsonl]
  history <room>          Alias for complete paginated room history.
  recent <room>           Alias for the latest signed-cursor history page.
  messages sync [--limit 200] [--reset] [--spool]
                          Reconcile event and account streams with durable cursors.
  messages send <room> <text...> [--reply-to event_id] [--client-id id]
  messages send-event <room> --data JSON
                          Send any Glass event type/content with idempotency.
  messages edit <event> <text...> --base-version n
  messages react <event> <emoji> [--active true|false]
  messages forward <target-room> <source-room> <event...> [--comment text]
  messages thread <event> [--all] | thread-read <event> <through-event>
  send <room> <text...>   Alias for messages send.
  dm <carbon|silicon> <handle-or-id> [text...]
  browser <room> <url> [--ttl 60]
  chat <room>             Interactive stdin chat for a room.
  listen [room|all]       Durable event/account stream with sync barrier,
                          dedupe, heartbeats, reconnect, and gap repair.
                          Spools by default; pass --no-spool to disable.
  daemon start|stop|restart|status|run
                          Keep a background silicon inbox listener alive.
  inbox list|clear|path   Read or manage the daemon JSONL inbox.
  operations list|resolve|prune|path
                          Inspect and reconcile ambiguous durable sends.

Drafts, held sends, and attachments:
  drafts list|show <room>|put <room> <text...>|delete <room>
  held list [room]
  held create <room> <text...> [--hold-seconds n]
  held patch <room> <held-id> --base-version n [...]
  held send-now|cancel <room> <held-id>
  send-file <room> <path> [caption...] [--client-id id]
  send-files <room> <2-10 paths...> [--caption text] [--reply-to event]
  attachments list <room> [--all] [--resolve]
  attachments download <room> [dir] [--all] [--force]
  media show <media-id> | media download <media-id> [path]

  Activity and event controls:
  presence <active|inactive>
  activity <room> <typing|uploading|recording> <on|off>
  typing <room> <on|off> Exact Glass typing-state endpoint.
  read <room> <event_id>
  progress <room> <state> [note...] [--group id] [--pct n]
  delta <event_id> <text...> [--seq n]
  final <event_id>
  take-back <event_id> [--reason text] [--force]
  take-back requests [--status pending]
  take-back complete <request_id> <replacement text...>
  delete <event_id>
  search <query...> [--room room] [--sender-kind kind] [--limit n] [--all]
  gif search <query...> [--limit 12]
  gif send <room> <gif_id> [caption...]

Jobs and automation:
  tts <text...> [--room room_id] [--voice name] [--scene x] [--style x]
  stt <media_id> [--language code]
  crons list [--mine] [--for id] [--setup-by silicon_id]
  crons show <cron_id>
  crons create --trigger "*/5 * * * *" --target carbon:alice --task "check in"
  crons patch <cron_id> [--trigger expr] [--task text] [--active true|false]
  crons delete <cron_id>
  sessions list | new <room> [summary...] | end <session_id> [summary...]
  contacts list | save <kind> <id> [--name n] [--note n] | update <id> ... | delete <id>

Teams, safety, and account services:
  teams list|show|create|patch|logo|members|silicons|reactivity|structure
  teams invites|invite-create|invite-disable|invitees <slug> [...]
  teams billing|plan|addon|roll|checkout <slug> [...]
  invites show|accept|verify-start|verify
  browser-session open <silicon-id>
                          Open or join the Silicon's Glass cloud-browser session.
  take-back-policy show|set [--enabled bool] [--unread-threshold n]
  moderation restrictions|appeals|appeal|report
  announcements
  cost summary|recent
  push vapid-key|subscribe --data JSON|unsubscribe <endpoint>
  challenge push <token>|answer --token t --type push|captcha --answer value

Complete Glass surface:
  glass schema [--output schema.json]
  glass get|post|put|patch|delete|head|options <api-path> [--query key=value]
        [--data JSON|--data-file file] [--form key=value] [--file field=path]
        [--raw-body file|-] [--header 'Name: value'] [--idempotent]
        [--response auto|json|text|binary] [--output file]
  api ...                 Alias for glass. This raw authenticated escape hatch
                          makes every current and future Glass endpoint available.
`);
}

async function cmdConfig(ctx, args) {
  const [sub, key, ...rest] = args;
  const fileConfig = readConfig();
  const allowed = new Set([
    "apiBase",
    "wsBase",
    "siliconKey",
    "accessToken",
    "refreshToken",
    "deviceId",
    "requestTimeout",
    "defaultRoom",
  ]);
  if (!sub || sub === "show" || sub === "get") {
    const shown = {
      path: CONFIG_PATH,
      ...fileConfig,
      siliconKey: fileConfig.siliconKey ? `${fileConfig.siliconKey.slice(0, 8)}...` : "",
      accessToken: fileConfig.accessToken ? `${fileConfig.accessToken.slice(0, 8)}...` : "",
      refreshToken: fileConfig.refreshToken ? `${fileConfig.refreshToken.slice(0, 8)}...` : "",
      effectiveApiBase: ctx.config.apiBase,
      effectiveWsBase: ctx.config.wsBase,
      effectiveSiliconKey: ctx.config.siliconKey ? `${ctx.config.siliconKey.slice(0, 8)}...` : "",
      effectiveAuthSource: ctx.config.detectedGlassPath
        ? ".glass.json"
        : fileConfig.siliconKey
          ? CONFIG_PATH
          : ctx.config.legacyConfigPath
            ? "legacy credentials"
            : "",
      detectedGlassPath: ctx.config.detectedGlassPath || "",
      detectedSiliconUsername: ctx.config.detectedSiliconUsername || "",
      legacyConfigPath: ctx.config.legacyConfigPath || "",
    };
    printResult(ctx, shown, (value) => printJson(value));
    return;
  }
  if (sub === "path") {
    console.log(CONFIG_PATH);
    return;
  }
  if (sub === "set") {
    if (!allowed.has(key)) throw new UsageError(`Unknown config key '${key}'.`);
    const value = rest.join(" ");
    if (!value) throw new UsageError("Missing config value.");
    fileConfig[key] = value;
    writeConfig(fileConfig);
    console.log(`Set ${key}.`);
    return;
  }
  if (sub === "clear") {
    if (!allowed.has(key)) throw new UsageError(`Unknown config key '${key}'.`);
    delete fileConfig[key];
    writeConfig(fileConfig);
    console.log(`Cleared ${key}.`);
    return;
  }
  throw new UsageError(`Unknown config command '${sub}'.`);
}

async function cmdInstall(ctx, args) {
  const { options, positionals } = parseOptions(args, ["noDaemon"]);
  const installed = installInto(positionals[0] || ".");
  const glass = loadGlassConfig(installed.target);
  let daemon = null;
  if (!options.noDaemon && glass.siliconKey) {
    const daemonCtx = {
      config: {
        ...ctx.config,
        apiBase: cleanBase(glass.apiBase || ctx.config.apiBase),
        wsBase: cleanBase(glass.wsBase || deriveWsBase(glass.apiBase || ctx.config.apiBase)),
        siliconKey: glass.siliconKey,
        accessToken: "",
        refreshToken: "",
        deviceId: "",
      },
    };
    daemon = await startDaemonProcess(daemonCtx, {
      root: installed.target,
      scriptPath: path.join(installed.package, "bin", "silicon-interface.mjs"),
      restart: true,
    });
  }
  installed.daemon = daemon
    ? { running: true, pid: daemon.pid, inbox: inboxPathForRoot(installed.target) }
    : { running: false, skipped: Boolean(options.noDaemon), reason: glass.siliconKey ? "disabled" : "no_glass_auth" };
  printResult(ctx, installed, (value) => {
    console.log(`Installed Silicon Interface CLI in ${value.target}`);
    console.log(`package: ${value.package}`);
    console.log(`bin: ${value.binDir}`);
    console.log(`run: ${path.join(value.binDir, "si")} help`);
    if (value.daemon.running) {
      console.log(`live inbox: started automatically (PID ${value.daemon.pid})`);
      console.log(`inbox: ${value.daemon.inbox}`);
    }
    if (!value.glassDetected) {
      console.log("note: no .glass.json detected yet; commands will need env auth or later Glass setup.");
    } else if (!glass.siliconKey) {
      console.log("note: .glass.json has no Silicon key yet; run `si auth import-glass` after Glass setup.");
    } else if (options.noDaemon) {
      console.log("note: automatic live inbox startup was disabled with --no-daemon.");
    }
  });
}

async function readLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function saveCarbonSession(ctx, fileConfig, initialTokens, options = {}) {
  let tokens = initialTokens;
  let deviceId = "";
  if (!options.noDevice) {
    deviceId = String(options.deviceId || ctx.config.deviceId || fileConfig.deviceId || `cli_${randomUUID()}`);
    ctx.config.accessToken = tokens.access;
    ctx.config.refreshToken = tokens.refresh || "";
    // A legacy token may register a device but cannot claim its namespace on
    // the registration request itself.
    ctx.config.deviceId = "";
    tokens = await api.registerDevice(ctx, {
      device_id: deviceId,
      platform: "cli",
      name: String(options.deviceName || os.hostname()).slice(0, 120),
      app_version: VERSION,
      capabilities: {
        chat_protocol: CHAT_PROTOCOL,
        event_sync: true,
        account_sync: true,
        multipart_upload: true,
      },
    });
  }
  fileConfig.accessToken = tokens.access;
  if (tokens.refresh) fileConfig.refreshToken = tokens.refresh;
  else delete fileConfig.refreshToken;
  if (deviceId) fileConfig.deviceId = deviceId;
  else delete fileConfig.deviceId;
  delete fileConfig.siliconKey;
  writeConfig(fileConfig);
  ctx.config.accessToken = tokens.access;
  ctx.config.refreshToken = tokens.refresh || "";
  ctx.config.deviceId = deviceId;
  ctx.config.siliconKey = "";
  return { tokens, deviceId };
}

async function startDaemonAfterAuth(ctx, options = {}) {
  if (options.noDaemon) return null;
  return startDaemonProcess(ctx, { restart: true });
}

function printAutomaticDaemon(ctx, daemon) {
  if (!daemon || ctx.config.json || ctx.config.jsonl) return;
  console.log(`Live inbox daemon started automatically (PID ${daemon.pid}).`);
}

async function cmdAuth(ctx, args) {
  const [sub, ...rest] = args;
  const fileConfig = readConfig();
  if (sub === "set-key") {
    const { options, positionals } = parseOptions(rest, ["noDaemon"]);
    let key = positionals.join(" ").trim();
    if (!key && !process.stdin.isTTY) key = fs.readFileSync(0, "utf8").trim();
    if (!key) key = (await readLine("Silicon key: ")).trim();
    if (!key) throw new UsageError("Missing silicon key.");
    fileConfig.siliconKey = key;
    delete fileConfig.accessToken;
    delete fileConfig.refreshToken;
    delete fileConfig.deviceId;
    writeConfig(fileConfig);
    ctx.config.siliconKey = key;
    ctx.config.accessToken = "";
    ctx.config.refreshToken = "";
    ctx.config.deviceId = "";
    const daemon = await startDaemonAfterAuth(ctx, options);
    console.log("Silicon key saved.");
    printAutomaticDaemon(ctx, daemon);
    return;
  }
  if (sub === "set-token") {
    const { options, positionals } = parseOptions(rest, ["noDaemon"]);
    const accessToken = String(positionals[0] || "").trim();
    if (!accessToken) throw new UsageError("Usage: auth set-token <access-token> [--refresh token] [--device-id id] [--no-daemon]");
    fileConfig.accessToken = accessToken;
    if (options.refresh) fileConfig.refreshToken = options.refresh;
    else delete fileConfig.refreshToken;
    if (options.deviceId || ctx.config.deviceId) {
      fileConfig.deviceId = options.deviceId || ctx.config.deviceId;
    }
    delete fileConfig.siliconKey;
    writeConfig(fileConfig);
    ctx.config.siliconKey = "";
    ctx.config.accessToken = accessToken;
    ctx.config.refreshToken = String(options.refresh || "");
    ctx.config.deviceId = String(options.deviceId || ctx.config.deviceId || "");
    const daemon = await startDaemonAfterAuth(ctx, options);
    console.log("Carbon access token saved.");
    printAutomaticDaemon(ctx, daemon);
    return;
  }
  if (sub === "available" || sub === "check-id") {
    const value = String(rest[0] || "").trim();
    if (!value) throw new UsageError("Usage: auth available <carbon-id>");
    const result = await api.carbonIdAvailable(ctx, value);
    printResult(ctx, result, (data) => {
      console.log(data.available ? "available" : `unavailable${data.reason ? `: ${data.reason}` : ""}`);
    });
    return;
  }
  if (sub === "register") {
    const { options } = parseOptions(rest, ["noDevice", "noDaemon"]);
    let email = String(options.email || "").trim();
    let phone = String(options.phone || "").trim();
    let username = String(options.username || "").trim();
    if (process.stdin.isTTY) {
      if (!email) email = (await readLine("Email: ")).trim();
      if (!phone) phone = (await readLine("Phone (E.164): ")).trim();
      if (!username) username = (await readLine("Carbon ID: ")).trim();
    }
    if (!email || !phone || !username) {
      throw new UsageError(
        "Usage: auth register --email address --phone +15551234567 --username carbon-id --email-code n --phone-code n",
      );
    }
    const availability = await api.carbonIdAvailable(ctx, username);
    if (!availability.available) {
      throw new UsageError(`Carbon ID is unavailable${availability.reason ? `: ${availability.reason}` : "."}`);
    }
    const emailStarted = await api.registerEmailStart(ctx, email, options.flowId || "");
    if (emailStarted.existing) throw new UsageError("That email already has an account; use auth login.");
    const flowId = emailStarted.flow_id || options.flowId;
    if (!flowId) throw new ProtocolError("Glass returned no registration flow id.");
    let emailCode = String(options.emailCode || "").trim();
    if (!emailCode && process.stdin.isTTY) emailCode = (await readLine(`Email code for ${email}: `)).trim();
    if (!emailCode) throw new UsageError("Registration needs --email-code in non-interactive mode.");
    await api.registerEmailVerify(ctx, flowId, email, emailCode);

    const phoneStarted = await api.registerPhoneStart(ctx, phone, flowId);
    if (phoneStarted.existing) throw new UsageError("That phone already has an account; use auth login.");
    let phoneCode = String(options.phoneCode || "").trim();
    if (!phoneCode && process.stdin.isTTY) phoneCode = (await readLine(`SMS code for ${phone}: `)).trim();
    if (!phoneCode) throw new UsageError("Registration needs --phone-code in non-interactive mode.");
    await api.registerPhoneVerify(ctx, flowId, phone, phoneCode);

    const registered = await api.registerUsername(ctx, flowId, username);
    const { deviceId } = await saveCarbonSession(ctx, fileConfig, registered, options);
    const daemon = await startDaemonAfterAuth(ctx, options);
    printResult(ctx, { carbon: registered.carbon, device_id: deviceId }, (data) => {
      console.log(`Carbon ${data.carbon?.username || username} registered${deviceId ? ` on ${deviceId}` : ""}.`);
    });
    printAutomaticDaemon(ctx, daemon);
    return;
  }
  if (sub === "login") {
    const { options, positionals } = parseOptions(rest, ["noDevice", "noDaemon"]);
    const identifier = String(positionals[0] || options.identifier || "").trim();
    if (!identifier) throw new UsageError("Usage: auth login <phone|email|username> [--code n]");
    let started = await api.loginStart(ctx, identifier);
    if (started.status === "choose_channel") {
      let channel = options.channel;
      if (!channel) {
        if (!process.stdin.isTTY) throw new UsageError("Login needs --channel sms|email.");
        const choices = (started.options || []).map((value) => value.channel).join("/");
        channel = (await readLine(`Channel (${choices}): `)).trim();
      }
      if (!["sms", "email"].includes(channel)) throw new UsageError("--channel must be sms or email.");
      started = await api.loginSelectChannel(ctx, started.challenge_id, channel);
    }
    let code = String(options.code || "").trim();
    if (!code && !process.stdin.isTTY) code = fs.readFileSync(0, "utf8").trim();
    if (!code) code = (await readLine(`Verification code sent to ${started.sent_to || identifier}: `)).trim();
    const tokens = await api.loginVerify(ctx, started.challenge_id, code);
    const { deviceId } = await saveCarbonSession(ctx, fileConfig, tokens, options);
    const daemon = await startDaemonAfterAuth(ctx, options);
    console.log(`Carbon login saved${deviceId ? ` for device ${deviceId}` : ""}.`);
    printAutomaticDaemon(ctx, daemon);
    return;
  }
  if (sub === "import-glass") {
    const { options, positionals } = parseOptions(rest, ["noDaemon"]);
    const glass = loadGlassConfig(positionals[0] || process.cwd());
    if (!glass.siliconKey) {
      throw new UsageError("No Glass api_key found. Run this inside a Glass-pulled silicon folder or pass a .glass.json path.");
    }
    fileConfig.siliconKey = glass.siliconKey;
    if (glass.apiBase) fileConfig.apiBase = cleanBase(glass.apiBase);
    if (glass.wsBase) fileConfig.wsBase = cleanBase(glass.wsBase);
    delete fileConfig.accessToken;
    delete fileConfig.refreshToken;
    delete fileConfig.deviceId;
    writeConfig(fileConfig);
    ctx.config.siliconKey = glass.siliconKey;
    ctx.config.accessToken = "";
    ctx.config.refreshToken = "";
    ctx.config.deviceId = "";
    if (glass.apiBase) ctx.config.apiBase = cleanBase(glass.apiBase);
    if (glass.wsBase) ctx.config.wsBase = cleanBase(glass.wsBase);
    const daemon = await startDaemonAfterAuth(ctx, options);
    console.log(`Imported Glass auth from ${glass.source}.`);
    printAutomaticDaemon(ctx, daemon);
    return;
  }
  if (sub === "clear") {
    const stopped = await stopDaemonProcess();
    delete fileConfig.siliconKey;
    delete fileConfig.accessToken;
    delete fileConfig.refreshToken;
    delete fileConfig.deviceId;
    writeConfig(fileConfig);
    console.log(`Auth cleared${stopped.stopped ? `; live inbox daemon stopped (PID ${stopped.pid})` : ""}.`);
    return;
  }
  if (!sub || sub === "status") {
    requireAuth(ctx);
    const me = ctx.config.siliconKey ? await api.meSilicon(ctx) : await api.meCarbon(ctx);
    printResult(ctx, me, (value) => {
      console.log(`${value.name || value.username} (${value.silicon_id || value.carbon_id})`);
      if (value.is_active != null) console.log(`active: ${value.is_active}`);
      if (value.tagline) console.log(`tagline: ${value.tagline}`);
    });
    return;
  }
  throw new UsageError(`Unknown auth command '${sub}'.`);
}

async function cmdStatus(ctx) {
  const health = await attempt(() => api.healthz(ctx));
  const ready = await attempt(() => api.readyz(ctx));
  const version = await attempt(() => api.version(ctx));
  const me = ctx.config.siliconKey || ctx.config.accessToken
    ? await attempt(() => (ctx.config.siliconKey ? api.meSilicon(ctx) : api.meCarbon(ctx)))
    : null;
  const rooms = ctx.config.siliconKey || ctx.config.accessToken ? await attempt(() => api.rooms(ctx)) : null;
  const result = {
    apiBase: ctx.config.apiBase,
    wsBase: ctx.config.wsBase,
    health: health.ok ? health.value : { error: health.error.message },
    ready: ready.ok ? ready.value : { error: ready.error.message },
    version: version.ok ? version.value : { error: version.error.message },
    silicon: me ? (me.ok ? me.value : { error: me.error.message }) : null,
    rooms: rooms ? (rooms.ok ? { count: rooms.value.length } : { error: rooms.error.message }) : null,
  };
  printResult(ctx, result, (value) => {
    console.log(`api: ${value.apiBase}`);
    console.log(`ws:  ${value.wsBase}`);
    console.log(`health: ${health.ok ? JSON.stringify(health.value) : health.error.message}`);
    console.log(`ready: ${ready.ok ? JSON.stringify(ready.value) : ready.error.message}`);
    console.log(`version: ${version.ok ? JSON.stringify(version.value) : version.error.message}`);
    if (me) {
      console.log(
        `identity: ${me.ok ? `${me.value.name || me.value.username} (${me.value.silicon_id || me.value.carbon_id})` : me.error.message}`,
      );
    }
    if (rooms) console.log(`rooms: ${rooms.ok ? rooms.value.length : rooms.error.message}`);
  });
}

async function cmdUpdate(ctx, args) {
  const [first, ...tail] = args;
  const sub = first && !first.startsWith("--") ? first : "check";
  const rest = first && !first.startsWith("--") ? tail : args;
  if (!["check", "trigger", "now"].includes(sub)) {
    throw new UsageError("Usage: update check|trigger [--no-force]");
  }
  const { options } = parseOptions(rest, ["noForce"]);
  const updatePath = findUp("update.py", interfaceRoot());
  if (!updatePath) {
    throw new UsageError("No update.py found. Run this inside a Glass-pulled silicon folder.");
  }
  const scriptArgs = options.noForce ? ["--no-force"] : [];
  const cwd = path.dirname(updatePath);
  const { command, result } = runPython(updatePath, scriptArgs, cwd);
  const payload = {
    ok: result.status === 0,
    command: [command, updatePath, ...scriptArgs].filter(Boolean).join(" "),
    cwd,
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
  if (ctx.config.json) {
    printJson(payload);
  } else {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    console.log(payload.ok ? "Update check finished." : "Update check failed.");
  }
  if (!payload.ok) process.exitCode = payload.status || 1;
}

async function cmdMe(ctx) {
  requireAuth(ctx);
  const me = ctx.config.siliconKey ? await api.meSilicon(ctx) : await api.meCarbon(ctx);
  printResult(ctx, me, (value) => printJson(value));
}

async function cmdProfile(ctx, args) {
  requireAuth(ctx);
  const [sub = "show", ...rest] = args;
  if (sub === "show" || sub === "get") {
    await cmdMe(ctx);
    return;
  }
  if (sub === "patch" || sub === "update") {
    if (ctx.config.siliconKey) {
      throw new UsageError("Silicon profile mutation is not exposed by Glass for this identity.");
    }
    const { options } = parseOptions(rest);
    const payload = jsonBodyOption(options, { required: true });
    const result = await api.patchMeCarbon(ctx, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: profile show | profile patch --data JSON");
}

async function cmdPreferences(ctx, args) {
  requireAuth(ctx);
  const [sub = "show", ...rest] = args;
  if (sub === "show" || sub === "get") {
    const result = await api.chatPreferences(ctx);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "set" || sub === "patch") {
    const { options } = parseOptions(rest);
    const payload = jsonBodyOption(options) || {};
    if (options.readReceipts != null) payload.read_receipts_enabled = asBool(options.readReceipts);
    if (options.presence != null) payload.presence_visibility = options.presence;
    if (options.notifications != null) {
      payload.notifications = parseJsonValue(options.notifications, "--notifications");
    }
    if (!Object.keys(payload).length) {
      throw new UsageError(
        "Pass --read-receipts, --presence, --notifications JSON, or --data JSON.",
      );
    }
    const result = await api.patchChatPreferences(ctx, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: preferences show | preferences set [options]");
}

async function cmdDevices(ctx, args) {
  requireAuth(ctx);
  if (ctx.config.siliconKey) throw new UsageError("Devices are available to Carbon identities only.");
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const result = await api.devices(ctx);
    printResult(ctx, result, (value) => {
      const rows = value.devices || [];
      if (!rows.length) console.log("No registered devices.");
      else printRows(rows, [
        { label: "DEVICE", value: (row) => row.device_id },
        { label: "PLATFORM", value: (row) => row.platform },
        { label: "NAME", value: (row) => row.name },
        { label: "VERSION", value: (row) => row.app_version },
        { label: "LAST SEEN", value: (row) => shortTime(row.last_seen_at) },
      ]);
    });
    return;
  }
  if (sub === "register") {
    const { options, positionals } = parseOptions(rest);
    const deviceId = String(positionals[0] || options.id || `cli_${randomUUID()}`);
    const result = await api.registerDevice(ctx, {
      device_id: deviceId,
      platform: options.platform || "cli",
      name: options.name || os.hostname(),
      app_version: options.appVersion || VERSION,
      capabilities: options.capabilities
        ? parseJsonValue(options.capabilities, "--capabilities")
        : { chat_protocol: CHAT_PROTOCOL, event_sync: true, account_sync: true },
    });
    const fileConfig = readConfig();
    fileConfig.deviceId = deviceId;
    fileConfig.accessToken = result.access;
    if (result.refresh) fileConfig.refreshToken = result.refresh;
    delete fileConfig.siliconKey;
    writeConfig(fileConfig);
    printResult(ctx, { device: result.device, saved: true }, (value) => {
      console.log(`Registered and selected ${value.device.device_id}.`);
    });
    return;
  }
  if (sub === "revoke") {
    const deviceId = rest[0];
    if (!deviceId) throw new UsageError("Usage: devices revoke <device-id>");
    const result = await api.revokeDevice(ctx, deviceId);
    const fileConfig = readConfig();
    if (fileConfig.deviceId === deviceId) {
      delete fileConfig.deviceId;
      delete fileConfig.accessToken;
      delete fileConfig.refreshToken;
      writeConfig(fileConfig);
    }
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: devices list|register|revoke ...");
}

async function cmdRooms(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const rooms = await api.rooms(ctx);
    printResult(ctx, rooms, (rows) => {
      if (!rows.length) {
        console.log("No rooms.");
        return;
      }
      printRows(rows, [
        { label: "ROOM", value: (r) => r.room_id },
        { label: "KIND", value: (r) => r.kind },
        { label: "UNREAD", value: (r) => r.unread_count || (r.unread ? 1 : 0) },
        { label: "PEERS", value: (r) => r.peers?.map((p) => `${p.kind}:${p.handle || p.id}`).join(",") || r.name },
        { label: "LAST", value: (r) => r.last_event?.preview || "" },
      ]);
    });
    return;
  }
  if (sub === "show") {
    const { options, positionals } = parseOptions(rest, ["events"]);
    const roomId = roomArg(ctx, positionals[0]);
    const [room, members, events] = await Promise.all([
      api.room(ctx, roomId),
      attempt(() => api.members(ctx, roomId)),
      api.historyPage(ctx, roomId, { limit: Number(options.limit || 20) })
        .then((page) => page.events),
    ]);
    const value = { room, members: members.ok ? members.value : null, events };
    printResult(ctx, value, (data) => {
      console.log(`${data.room.room_id} ${data.room.kind} ${data.room.name || ""}`);
      if (data.room.peers?.length) {
        console.log(`peers: ${data.room.peers.map((p) => `${p.kind}:${p.handle || p.id}`).join(", ")}`);
      }
      if (data.members) console.log(`members: ${data.members.length}`);
      console.log("");
      for (const event of data.events) console.log(eventLine(event));
    });
    return;
  }
  if (sub === "create") {
    const { options, positionals } = parseOptions(rest);
    const name = String(options.name || positionals.join(" ")).trim();
    if (!name) throw new UsageError("Usage: rooms create <name...> [--topic text]");
    const room = await api.createRoom(ctx, { name, topic: options.topic || "" });
    printResult(ctx, room, (value) => console.log(`${value.room_id} ${value.name || ""}`));
    return;
  }
  if (sub === "patch" || sub === "update") {
    const { options, positionals } = parseOptions(rest);
    const roomId = roomArg(ctx, positionals[0]);
    const patch = {};
    if (options.name != null) patch.name = options.name;
    if (options.topic != null) patch.topic = options.topic;
    if (!Object.keys(patch).length) throw new UsageError("Pass --name and/or --topic.");
    const room = await api.patchRoom(ctx, roomId, patch);
    printResult(ctx, room, (value) => printJson(value));
    return;
  }
  if (sub === "members") {
    const roomId = roomArg(ctx, rest[0]);
    const members = await api.members(ctx, roomId);
    printResult(ctx, members, (rows) => printRows(rows, [
      { label: "KIND", value: (member) => member.member_kind },
      { label: "ID", value: (member) => member.member_id },
      { label: "ROLE", value: (member) => member.role },
      { label: "READ", value: (member) => member.last_read_event_id || "" },
    ]));
    return;
  }
  if (sub === "preferences" || sub === "list-preferences") {
    const { options, positionals } = parseOptions(rest);
    const roomId = roomArg(ctx, positionals[0]);
    const payload = {};
    if (options.pinned != null) payload.pinned = asBool(options.pinned);
    if (options.archived != null) payload.archived = asBool(options.archived);
    if (!Object.keys(payload).length) throw new UsageError("Pass --pinned and/or --archived.");
    const result = await api.patchRoomListPreferences(ctx, roomId, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "add-member") {
    const { options, positionals } = parseOptions(rest);
    const [roomToken, kind, memberId] = positionals;
    if (!roomToken || !["carbon", "silicon"].includes(kind) || !/^\d+$/.test(memberId || "")) {
      throw new UsageError(
        "Usage: rooms add-member <room> <carbon|silicon> <numeric-member-id> [--role member]",
      );
    }
    const member = await api.addMember(ctx, roomArg(ctx, roomToken), {
      member_kind: kind,
      // Glass intentionally accepts the internal numeric principal id here.
      // Public handle lookups return public ids and cannot safely be substituted.
      member_id: Number(memberId),
      role: options.role || "member",
    });
    printResult(ctx, member, (value) => printJson(value));
    return;
  }
  if (sub === "direct" || sub === "dm") {
    const [kind, targetValue] = rest;
    if (kind !== "carbon" && kind !== "silicon") {
      throw new UsageError("Usage: rooms direct <carbon|silicon> <handle-or-id>");
    }
    if (!targetValue) throw new UsageError("Missing direct-room target.");
    const target = await resolveTarget(ctx, kind, targetValue);
    const room = await api.directRoom(ctx, kind, target.id);
    printResult(ctx, room, (value) => {
      console.log(value.room_id);
      if (value.peers?.length) {
        console.log(value.peers.map((p) => `${p.kind}:${p.handle || p.id}`).join(", "));
      }
    });
    return;
  }
  throw new UsageError(`Unknown rooms command '${sub}'.`);
}

async function fetchRoomHistory(
  ctx,
  roomId,
  { all = true, limit = 200, cursor = "", direction = "backward", anchor = "", maxEvents = 0 } = {},
) {
  const pages = [];
  let nextCursor = cursor;
  let nextAnchor = anchor;
  let restarts = 0;
  while (true) {
    let page;
    try {
      page = await api.historyPage(ctx, roomId, {
        cursor: nextCursor,
        limit,
        direction,
        anchor: nextAnchor || undefined,
      });
    } catch (error) {
      const code = error instanceof ApiError && error.body && typeof error.body === "object"
        ? error.body.code
        : "";
      const oldest = pages.at(-1)?.events?.[0]?.event_id;
      if (code === "cursor_expired" && oldest && restarts < 3) {
        nextCursor = "";
        nextAnchor = oldest;
        restarts += 1;
        continue;
      }
      throw error;
    }
    syncInvariant(Array.isArray(page?.events), "Glass returned a malformed history page.");
    pages.push(page);
    const count = pages.reduce((sum, current) => sum + current.events.length, 0);
    if (!all || !page.has_more || !page.cursor || (maxEvents && count >= maxEvents)) break;
    nextCursor = page.cursor;
    nextAnchor = "";
  }
  const events =
    direction === "backward"
      ? pages.toReversed().flatMap((page) => page.events)
      : pages.flatMap((page) => page.events);
  return {
    room_id: roomId,
    events: maxEvents ? events.slice(-maxEvents) : events,
    count: maxEvents ? Math.min(events.length, maxEvents) : events.length,
    complete: !pages.at(-1)?.has_more,
    cursor: pages.at(-1)?.cursor || null,
    through_event_id: pages[0]?.through_event_id || null,
    pages: pages.length,
  };
}

function atomicWriteText(filePath, textValue, mode = 0o600) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temp = `${resolved}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, textValue, { mode });
    fs.renameSync(temp, resolved);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return resolved;
}

function atomicWriteBytes(filePath, bytes, mode = 0o600) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temp = `${resolved}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { mode });
    fs.renameSync(temp, resolved);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return resolved;
}

function writeHistoryFile(filePath, history, format = "") {
  const resolvedFormat = format || (String(filePath).toLowerCase().endsWith(".jsonl") ? "jsonl" : "json");
  const body = resolvedFormat === "jsonl"
    ? `${history.events.map((event) => JSON.stringify(event)).join("\n")}${history.events.length ? "\n" : ""}`
    : `${JSON.stringify(history, null, 2)}\n`;
  return atomicWriteText(filePath, body);
}

async function cmdMessages(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls" || sub === "recent") {
    const { options, positionals } = parseOptions(rest);
    const roomId = roomArg(ctx, positionals[0]);
    const page = await api.historyPage(ctx, roomId, {
      cursor: typeof options.cursor === "string" ? options.cursor : "",
      limit: numberOption(options.limit, 50, { min: 1, max: 200 }),
      direction: options.direction === "forward" ? "forward" : "backward",
      anchor: options.anchor,
    });
    printResult(ctx, page, (value) => {
      for (const event of value.events || []) console.log(eventLine(event));
      if (value.has_more && value.cursor) console.error(`more history available; cursor: ${value.cursor}`);
    });
    return;
  }
  if (sub === "history" || sub === "all") {
    const { options, positionals } = parseOptions(rest, ["all"]);
    const roomId = roomArg(ctx, positionals[0]);
    const history = await fetchRoomHistory(ctx, roomId, {
      all: options.all !== false,
      limit: numberOption(options.limit, 200, { min: 1, max: 200 }),
      direction: options.direction === "forward" ? "forward" : "backward",
      anchor: options.anchor || "",
      maxEvents: numberOption(options.max, 0, { min: 0, max: Number.MAX_SAFE_INTEGER }),
    });
    if (options.output) {
      const output = writeHistoryFile(options.output, history, options.format);
      if (ctx.config.json || ctx.config.jsonl) printResult(ctx, { ...history, events: undefined, output }, () => {});
      else console.log(`Exported ${history.count} event(s) to ${output}`);
    } else {
      printResult(ctx, history, (value) => {
        for (const event of value.events) console.log(eventLine(event));
        console.error(`${value.count} event(s), ${value.pages} page(s).`);
      });
    }
    return;
  }
  if (sub === "sync") {
    const { options } = parseOptions(rest, ["reset", "spool"]);
    const syncCtx = { ...ctx, syncScope: "manual-sync" };
    if (options.reset) resetStreamCheckpoint(syncCtx);
    const result = await syncDurableStreams(syncCtx, {
      limit: numberOption(options.limit, 200, { min: 1, max: 500 }),
      print: !ctx.config.json,
      spool: Boolean(options.spool),
    });
    if (ctx.config.json) printJson(result);
    return;
  }
  if (sub === "send") {
    await sendMessage(ctx, rest);
    return;
  }
  if (sub === "send-event" || sub === "post") {
    const { options, positionals } = parseOptions(rest);
    const roomId = roomArg(ctx, positionals[0]);
    const payload = jsonBodyOption(options) || {
      type: options.type,
      content: options.content ? parseJsonValue(options.content, "--content") : {},
    };
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof payload.type !== "string" ||
      (payload.content != null &&
        (typeof payload.content !== "object" || Array.isArray(payload.content)))
    ) {
      throw new UsageError(
        "Usage: messages send-event <room> --data '{\"type\":\"m.text\",\"content\":{...}}'",
      );
    }
    const event = await sendEventReliable(ctx, roomId, payload, {
      clientId: typeof options.clientId === "string" ? options.clientId : undefined,
      signature: { roomId, payload },
    });
    printResult(ctx, event, (value) => console.log(eventLine(value)));
    return;
  }
  if (sub === "edit") {
    const { options, positionals } = parseOptions(rest);
    const [eventId, ...bodyParts] = positionals;
    const body = bodyParts.join(" ").trim();
    if (!eventId || !body) throw new UsageError("Usage: messages edit <event_id> <text...> --base-version n");
    const result = await api.editEvent(ctx, eventId, {
      body,
      base_version: numberOption(options.baseVersion, 1, { min: 1 }),
    });
    printResult(ctx, result, (event) => console.log(eventLine(event)));
    return;
  }
  if (sub === "react") {
    const { options, positionals } = parseOptions(rest);
    const [eventId, emoji] = positionals;
    if (!eventId || !emoji) throw new UsageError("Usage: messages react <event_id> <emoji> [--active true|false]");
    const operation = beginOperation(ctx, "reaction", { eventId, emoji, active: asBool(options.active ?? true) });
    const result = await api.reaction(ctx, eventId, {
      emoji,
      active: asBool(options.active ?? true),
      client_id: operation.clientId,
    });
    finishOperation(operation, { eventId, active: result.active });
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "forward") {
    const { options, positionals } = parseOptions(rest);
    const [targetRoom, sourceRoom, ...eventIds] = positionals;
    if (!targetRoom || !sourceRoom || !eventIds.length) {
      throw new UsageError("Usage: messages forward <target_room> <source_room> <event_id...> [--comment text]");
    }
    const result = await api.forwardEvents(ctx, roomArg(ctx, targetRoom), {
      source_room_id: sourceRoom,
      source_event_ids: eventIds,
      ...(options.comment ? { comment: options.comment } : {}),
    });
    printResult(ctx, result, (events) => events.forEach((event) => console.log(eventLine(event))));
    return;
  }
  if (sub === "thread") {
    const { options, positionals } = parseOptions(rest, ["all"]);
    const [eventId] = positionals;
    if (!eventId) throw new UsageError("Usage: messages thread <event_id> [--all]");
    const pages = [];
    let cursor = "";
    do {
      const page = await api.thread(ctx, eventId, {
        cursor,
        limit: numberOption(options.limit, 50, { min: 1, max: 100 }),
      });
      pages.push(page);
      cursor = options.all && page.has_more ? page.cursor || "" : "";
    } while (cursor);
    const value = {
      root: pages[0].root,
      events: pages.toReversed().flatMap((page) => page.events || []),
      unread_count: pages[0].unread_count,
      reply_count: pages[0].reply_count,
    };
    printResult(ctx, value, (thread) => {
      if (thread.root) console.log(eventLine(thread.root));
      for (const event of thread.events) console.log(`  ${eventLine(event)}`);
    });
    return;
  }
  if (sub === "thread-read") {
    const [eventId, throughEventId] = rest;
    if (!eventId || !throughEventId) {
      throw new UsageError("Usage: messages thread-read <root_or_reply_event_id> <through_event_id>");
    }
    const result = await api.threadRead(ctx, eventId, throughEventId);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError(`Unknown messages command '${sub}'.`);
}

async function sendEventReliable(ctx, roomId, payload, { clientId, signature } = {}) {
  const operation = clientId
    ? {
        context: streamStateKey(ctx),
        signature: operationSignature("event-send-explicit", { roomId, clientId }),
        clientId,
      }
    : beginOperation(ctx, "event-send", signature || { roomId, payload });
  const reliablePayload = {
    ...payload,
    content: { ...(payload.content || {}), client_id: operation.clientId },
  };
  const event = await api.sendEvent(ctx, roomId, reliablePayload);
  if (!clientId) finishOperation(operation, { eventId: event.event_id, roomId });
  return event;
}

async function sendMessage(ctx, args) {
  const { options, positionals } = parseOptions(args);
  const roomId = roomArg(ctx, positionals[0]);
  const body = positionals.slice(1).join(" ").trim();
  if (!body) throw new UsageError("Missing message text.");
  const payload = {
    type: options.type || "m.text",
    content: { body },
  };
  if (options.replyTo) payload.reply_to_event_id = options.replyTo;
  if (options.final != null) payload.is_final = asBool(options.final);
  const event = await sendEventReliable(ctx, roomId, payload, {
    clientId: typeof options.clientId === "string" ? options.clientId : undefined,
    signature: {
      roomId,
      type: payload.type,
      body,
      replyTo: payload.reply_to_event_id || "",
      final: payload.is_final ?? true,
    },
  });
  printResult(ctx, event, (value) => console.log(eventLine(value)));
}

async function cmdRemoteBrowser(ctx, args) {
  requireAuth(ctx);
  const { options, positionals } = parseOptions(args);
  const roomId = roomArg(ctx, positionals[0]);
  const url = positionals[1];
  if (!url) throw new UsageError("Usage: browser <room> <url> [--ttl 60]");
  try {
    new globalThis.URL(url);
  } catch {
    throw new UsageError(`Invalid URL: ${url}`);
  }
  const ttlRaw = options.ttlMinutes ?? options.ttl;
  const ttlMinutes = ttlRaw == null ? undefined : Number(ttlRaw);
  if (ttlRaw != null && (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0)) {
    throw new UsageError("--ttl must be a positive number of minutes.");
  }
  const content = { url };
  if (ttlMinutes !== undefined) content.ttl_minutes = Math.floor(ttlMinutes);
  const event = await sendEventReliable(
    ctx,
    roomId,
    { type: "m.remote_browser", content },
    { signature: { roomId, type: "m.remote_browser", content } },
  );
  printResult(ctx, event, (value) => console.log(eventLine(value)));
}

async function cmdDm(ctx, args) {
  requireAuth(ctx);
  const [kind, targetValue, ...messageParts] = args;
  if (kind !== "carbon" && kind !== "silicon") {
    throw new UsageError("Usage: dm <carbon|silicon> <handle-or-id> [message...]");
  }
  if (!targetValue) throw new UsageError("Missing DM target.");
  const target = await resolveTarget(ctx, kind, targetValue);
  const room = await api.directRoom(ctx, kind, target.id);
  const body = messageParts.join(" ").trim();
  if (!body) {
    printResult(ctx, room, (value) => console.log(value.room_id));
    return;
  }
  const event = await sendEventReliable(
    ctx,
    room.room_id,
    { type: "m.text", content: { body } },
    { signature: { roomId: room.room_id, type: "m.text", body } },
  );
  printResult(ctx, { room, event }, (value) => {
    console.log(`room: ${value.room.room_id}`);
    console.log(eventLine(value.event));
  });
}

async function openSocket(
  ctx,
  roomIds,
  onFrame,
  { holdFrames = false, acknowledgeFrames = false } = {},
) {
  requireAuth(ctx);
  const SocketCtor = globalThis.WebSocket;
  if (typeof SocketCtor !== "function") {
    throw new UsageError("This Node runtime has no global WebSocket. Use Node 22+ or run REST commands.");
  }
  const qs = new URLSearchParams();
  if (ctx.config.siliconKey) {
    qs.set("silicon_key", ctx.config.siliconKey);
  } else {
    const ticket = await api.wsTicket(ctx);
    if (!ticket?.ticket) throw new ProtocolError("Glass returned no WebSocket ticket.");
    qs.set("ticket", ticket.ticket);
  }
  const socket = new SocketCtor(`${ctx.config.wsBase}/ws/v1/?${qs}`);
  let released = !holdFrames;
  let buffered = [];
  let hello = null;
  let lastActivity = Date.now();
  let heartbeat = null;
  let settled = false;
  let resolveHello;
  let rejectHello;
  const acknowledge = (eventIds) => {
    if (!ctx.config.deviceId || !eventIds.length || socket.readyState !== SocketCtor.OPEN) return;
    socket.send(JSON.stringify({
      type: "event.ack",
      request_id: `cli_${randomUUID().replaceAll("-", "")}`,
      event_ids: eventIds,
    }));
  };
  const helloPromise = new Promise((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });

  socket.addEventListener("message", (event) => {
    lastActivity = Date.now();
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      socket.close(4400, "malformed frame");
      return;
    }
    try {
      if (frame?.type === "hello") {
        if (hello) {
          socket.close(4400, "duplicate hello");
          return;
        }
        const protocol = Number(frame.protocol_version ?? CHAT_PROTOCOL);
        const minimum = Number(frame.protocol_min ?? protocol);
        const maximum = Number(frame.protocol_max ?? protocol);
        if (
          !Number.isSafeInteger(protocol) ||
          !Number.isSafeInteger(minimum) ||
          !Number.isSafeInteger(maximum) ||
          minimum > protocol ||
          protocol > maximum ||
          typeof frame.cursor !== "string" ||
          typeof frame.account_cursor !== "string"
        ) {
          rejectHello(new ProtocolError("Glass returned a malformed WebSocket hello frame."));
          socket.close(4400, "malformed hello");
          return;
        }
        if (CHAT_PROTOCOL < minimum || CHAT_PROTOCOL > maximum) {
          rejectHello(
            new ProtocolError(
              `Glass WebSocket supports protocol ${minimum}-${maximum}; this CLI speaks ${CHAT_PROTOCOL}.`,
            ),
          );
          socket.close(4400, "protocol incompatible");
          return;
        }
        hello = frame;
        settled = true;
        resolveHello(frame);
        return;
      }
      if (frame?.type === "pong") return;
      if (!released) {
        if (buffered.length >= MAX_BUFFERED_FRAMES) {
          rejectHello(new ProtocolError("WebSocket barrier buffer overflowed."));
          socket.close(4408, "barrier overflow");
          return;
        }
        buffered.push(frame);
        return;
      }
      const stored = onFrame(frame);
      if (acknowledgeFrames && stored && frame?.type === "event" && frame.event?.event_id) {
        acknowledge([frame.event.event_id]);
      }
    } catch (error) {
      if (!settled) rejectHello(error);
      socket.close(1011, "frame handling failed");
    }
  });
  socket.addEventListener("open", () => {
    lastActivity = Date.now();
    for (const roomId of roomIds) {
      socket.send(JSON.stringify({ type: "subscribe", room_id: roomId }));
    }
  }, { once: true });
  socket.addEventListener("error", (event) => {
    if (!settled) rejectHello(new TransportError(event?.message || "WebSocket failed to open."));
  });
  socket.addEventListener("close", (event) => {
    if (heartbeat) clearInterval(heartbeat);
    if (!settled) {
      rejectHello(
        new TransportError(`WebSocket closed before hello (${event.code || "no code"}).`),
      );
    }
  }, { once: true });

  const helloTimeout = setTimeout(() => {
    if (!settled) {
      rejectHello(new TransportError("WebSocket hello timed out."));
      socket.close(4408, "hello timeout");
    }
  }, Math.min(ctx.config.requestTimeout || REQUEST_TIMEOUT_MS, 30_000));
  try {
    hello = await helloPromise;
  } finally {
    globalThis.clearTimeout(helloTimeout);
  }
  const interval = numberOption(hello.heartbeat_interval_ms, PING_INTERVAL_MS, {
    min: 10_000,
    max: 60_000,
  });
  const timeout = numberOption(hello.heartbeat_timeout_ms, PING_TIMEOUT_MS, {
    min: interval * 2,
    max: 180_000,
  });
  heartbeat = setInterval(() => {
    if (socket.readyState !== SocketCtor.OPEN) return;
    if (Date.now() - lastActivity >= timeout) {
      socket.close(4408, "heartbeat timeout");
      return;
    }
    socket.send(JSON.stringify({ type: "ping" }));
  }, interval);

  return {
    socket,
    hello,
    acknowledge,
    close: (code = 1000, reason = "") => socket.close(code, reason),
    release() {
      if (released) return [];
      released = true;
      const frames = buffered;
      buffered = [];
      return frames;
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mediaSendRetryDelay(error) {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body && typeof error.body === "object" ? error.body : null;
  const failure = body?.failure && typeof body.failure === "object" ? body.failure : null;
  const code = typeof body?.code === "string" ? body.code : failure?.code;
  if (!new Set(["media_not_ready", "transcription_pending"]).has(code)) return null;
  return Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0
    ? error.retryAfterMs
    : MEDIA_SEND_DEFAULT_RETRY_MS;
}

async function sendMediaEvent(ctx, roomId, payload) {
  const deadline = Date.now() + MEDIA_SEND_RETRY_TIMEOUT_MS;
  let retries = 0;
  while (true) {
    try {
      return await api.sendEvent(ctx, roomId, payload);
    } catch (error) {
      const delay = mediaSendRetryDelay(error);
      if (
        delay === null ||
        retries >= MEDIA_SEND_MAX_RETRIES ||
        Date.now() + delay > deadline
      ) {
        throw error;
      }
      retries += 1;
      await sleep(delay);
    }
  }
}

function frameIdentity(frame) {
  if (frame?.type === "event") {
    const writer = frame.event?.stream_writer;
    const position = frame.event?.stream_position;
    if (writer && Number.isSafeInteger(position)) return `event:${writer}:${position}`;
    if (frame.event?.event_id) return `event-id:${frame.event.event_id}`;
  }
  if (frame?.type === "account.state" && Number.isSafeInteger(frame.position)) {
    return `account:${frame.position}`;
  }
  return "";
}

function emitFrame(
  ctx,
  frame,
  { print = true, spool = false, seen, roomFilter = "", source = "live" } = {},
) {
  if (roomFilter && frame?.room_id && frame.room_id !== roomFilter) return false;
  const identity = frameIdentity(frame);
  if (identity && seen) {
    if (seen.has(identity)) return spool && source === "live";
    seen.add(identity);
    if (seen.size > 100_000) seen.delete(seen.values().next().value);
  }
  const recorded = source === "live" ? frame : { ...frame, _source: source };
  if (spool && !appendInbox(recorded, inboxContextKey(ctx))) {
    return source === "live";
  }
  if (!print) return true;
  if (ctx.config.json || ctx.config.jsonl) printJson(recorded, true);
  else console.log(frameLine(frame));
  return true;
}

async function flushPendingDeliveries(ctx) {
  if (!ctx.config.deviceId) return 0;
  let acknowledged = 0;
  const pending = pendingDeliveryIds(ctx);
  for (let index = 0; index < pending.length; index += 500) {
    const eventIds = pending.slice(index, index + 500);
    const result = await api.acknowledgeDelivered(ctx, eventIds);
    removePendingDeliveryIds(ctx, eventIds);
    acknowledged += Number(result?.acknowledged || 0);
  }
  return acknowledged;
}

function syncInvariant(condition, message) {
  if (!condition) throw new SyncIntegrityError(message);
}

function safePosition(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeStreamVector(value, label = "stream") {
  syncInvariant(value && typeof value === "object" && !Array.isArray(value), `${label} vector is malformed.`);
  syncInvariant(safePosition(value.floor), `${label} vector has an invalid floor.`);
  syncInvariant(
    value.writers && typeof value.writers === "object" && !Array.isArray(value.writers),
    `${label} vector has an invalid writer map.`,
  );
  const writers = {};
  const entries = Object.entries(value.writers);
  syncInvariant(entries.length <= 64, `${label} vector has too many writers.`);
  for (const [writer, position] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    syncInvariant(/^[a-z0-9][a-z0-9._-]{0,63}$/.test(writer), `${label} vector has an invalid writer.`);
    syncInvariant(safePosition(position) && position > value.floor, `${label} vector is not canonical.`);
    writers[writer] = position;
  }
  return { floor: value.floor, writers };
}

function vectorPositionFor(vector, writer) {
  return vector.writers[writer] ?? vector.floor;
}

function streamVectorEqual(left, right) {
  const a = normalizeStreamVector(left, "left");
  const b = normalizeStreamVector(right, "right");
  if (a.floor !== b.floor) return false;
  const writers = new Set([...Object.keys(a.writers), ...Object.keys(b.writers)]);
  return [...writers].every((writer) => vectorPositionFor(a, writer) === vectorPositionFor(b, writer));
}

function streamVectorBeforeOrEqual(left, right) {
  const a = normalizeStreamVector(left, "left");
  const b = normalizeStreamVector(right, "right");
  if (a.floor > b.floor) return false;
  const writers = new Set([...Object.keys(a.writers), ...Object.keys(b.writers)]);
  return [...writers].every((writer) => vectorPositionFor(a, writer) <= vectorPositionFor(b, writer));
}

function streamVectorIncludes(vector, writer, position) {
  const normalized = normalizeStreamVector(vector, "checkpoint");
  return (
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(writer || "")) &&
    safePosition(position) &&
    position <= vectorPositionFor(normalized, writer)
  );
}

function validateNumericSyncRange(stream, page, positions, expectedFrom, expectedThrough) {
  const range = page?.range;
  syncInvariant(range && typeof range === "object", `${stream} sync page has no coverage range.`);
  syncInvariant(typeof page.cursor === "string" && page.cursor, `${stream} sync page has no cursor.`);
  syncInvariant(typeof page.through === "string" && page.through, `${stream} sync page has no barrier.`);
  syncInvariant(range.stream === stream, `${stream} sync page names the wrong stream.`);
  syncInvariant(
    range.coverage === (stream === "events" ? "authoritative_projection" : "contiguous"),
    `${stream} sync page has an unsupported coverage proof.`,
  );
  syncInvariant(range.from_position === expectedFrom, `${stream} sync checkpoint is discontinuous.`);
  if (expectedThrough !== undefined) {
    syncInvariant(range.through_position === expectedThrough, `${stream} sync barrier changed mid-page.`);
  }
  syncInvariant(
    safePosition(range.next_position) && safePosition(range.through_position) &&
      range.from_position <= range.next_position && range.next_position <= range.through_position,
    `${stream} sync range moves backward or beyond its barrier.`,
  );
  syncInvariant(range.item_count === positions.length, `${stream} sync item count is inconsistent.`);
  syncInvariant(range.has_more === page.has_more, `${stream} sync continuation is inconsistent.`);
  syncInvariant(
    range.complete_through === !page.has_more,
    `${stream} sync completion marker is inconsistent.`,
  );
  syncInvariant(
    range.first_item_position === (positions[0] ?? null) &&
      range.last_item_position === (positions.at(-1) ?? null),
    `${stream} sync item boundary is inconsistent.`,
  );
  let previous = range.from_position;
  for (const position of positions) {
    syncInvariant(Number.isSafeInteger(position) && position > previous, `${stream} sync items are not ordered.`);
    if (stream === "account") {
      syncInvariant(position === previous + 1, "account sync skipped a durable position.");
    }
    syncInvariant(position <= range.next_position, `${stream} sync item lies beyond its checkpoint.`);
    previous = position;
  }
  syncInvariant(
    page.has_more ? range.next_position < range.through_position : range.next_position === range.through_position,
    `${stream} sync completion proof is inconsistent.`,
  );
  return range;
}

function validateEventSyncPage(page, checkpoint, expectedThroughVector) {
  syncInvariant(Array.isArray(page?.frames), "event sync payload is not an array.");
  const positions = page.frames.map((frame) => {
    syncInvariant(frame?.type === "event" && frame.event?.event_id, "event sync frame is malformed.");
    syncInvariant(frame.room_id, "event sync frame has no room.");
    return frame.event.stream_position;
  });
  if (!page.vector_range) {
    const range = validateNumericSyncRange(
      "events",
      page,
      positions,
      checkpoint.eventPosition,
      expectedThroughVector?.floor,
    );
    return {
      next: { floor: range.next_position, writers: {} },
      through: { floor: range.through_position, writers: {} },
    };
  }
  const proof = page.vector_range;
  syncInvariant(proof.version === 1 && proof.stream === "events", "unsupported event vector proof.");
  syncInvariant(proof.coverage === "authoritative_projection", "unsupported event coverage proof.");
  const from = normalizeStreamVector(proof.from, "from");
  const next = normalizeStreamVector(proof.next, "next");
  const through = normalizeStreamVector(proof.through, "through");
  syncInvariant(streamVectorEqual(from, checkpoint.eventVector), "event vector is discontinuous.");
  if (expectedThroughVector) {
    syncInvariant(streamVectorEqual(through, expectedThroughVector), "event vector barrier changed mid-sync.");
  }
  syncInvariant(streamVectorBeforeOrEqual(from, next), "event vector moved backward.");
  syncInvariant(streamVectorBeforeOrEqual(next, through), "event vector moved beyond its barrier.");
  syncInvariant(Array.isArray(proof.items), "event vector items are malformed.");
  syncInvariant(
    proof.item_count === page.frames.length && proof.items.length === page.frames.length,
    "event vector item count is inconsistent.",
  );
  syncInvariant(proof.has_more === page.has_more, "event vector continuation is inconsistent.");
  syncInvariant(proof.complete_through === !page.has_more, "event vector completion is inconsistent.");
  let previousPosition = -1;
  proof.items.forEach((item, index) => {
    const event = page.frames[index].event;
    syncInvariant(
      item.writer === event.stream_writer && item.position === event.stream_position,
      "event vector item does not match its event.",
    );
    syncInvariant(
      item.position > vectorPositionFor(from, item.writer) &&
        item.position <= vectorPositionFor(next, item.writer),
      "event vector repeated or overran an item.",
    );
    syncInvariant(item.position > previousPosition, "event vector items are not ordered.");
    previousPosition = item.position;
  });
  syncInvariant(
    page.has_more ? !streamVectorEqual(next, through) : streamVectorEqual(next, through),
    "event vector terminal state is inconsistent.",
  );
  return { next, through };
}

function validateAccountSyncPage(page, checkpoint, expectedThrough) {
  syncInvariant(Array.isArray(page?.updates), "account sync payload is not an array.");
  for (const update of page.updates) {
    syncInvariant(
      update && typeof update.kind === "string" && Number.isSafeInteger(update.position),
      "account sync update is malformed.",
    );
  }
  return validateNumericSyncRange(
    "account",
    page,
    page.updates.map((update) => update.position),
    checkpoint.accountPosition,
    expectedThrough,
  );
}

async function bootstrapStreamCheckpoint(
  ctx,
  { print = false, spool = false, roomFilter = "" } = {},
) {
  let cursor = "";
  let first = null;
  let pages = 0;
  const deliveryIds = [];
  do {
    const page = await api.initialSync(ctx, { cursor, limit: 100, timelineLimit: 50 });
    syncInvariant(page?.sync_version === 1, "Glass returned an unsupported initial sync version.");
    syncInvariant(page.continuity?.complete_at_barrier === true, "Initial snapshot is not complete.");
    syncInvariant(page.through && page.account_through, "Initial snapshot has no durable barriers.");
    syncInvariant(Array.isArray(page.rooms), "Initial snapshot has malformed rooms.");
    syncInvariant(
      safePosition(page.continuity.event_position) && safePosition(page.continuity.account_position),
      "Initial snapshot has malformed positions.",
    );
    if (!first) first = page;
    const rooms = roomFilter
      ? (page.rooms || []).filter((room) => room.room_id === roomFilter)
      : page.rooms || [];
    if (spool && ctx.config.deviceId) {
      for (const room of rooms) {
        for (const event of room.timeline?.events || []) deliveryIds.push(event.event_id);
      }
    }
    emitFrame(
      ctx,
      { type: "initial.snapshot", page: pages, rooms, account_data: page.account_data },
      { print, spool, source: "initial-sync" },
    );
    pages += 1;
    cursor = page.has_more ? page.next || "" : "";
    syncInvariant(!page.has_more || cursor, "Initial snapshot requires a missing continuation.");
  } while (cursor);
  const checkpoint = {
    event: first.through,
    account: first.account_through,
    eventPosition: first.continuity.event_position,
    eventVector: normalizeStreamVector(
      first.continuity.event_vector || { floor: first.continuity.event_position, writers: {} },
      "initial",
    ),
    accountPosition: first.continuity.account_position,
    bootstrapped: true,
  };
  syncInvariant(
    checkpoint.eventVector.floor === checkpoint.eventPosition,
    "Initial event scalar and vector checkpoints disagree.",
  );
  writeStreamCheckpoint(ctx, checkpoint, deliveryIds);
  if (deliveryIds.length) await flushPendingDeliveries(ctx);
  return checkpoint;
}

async function syncEventStream(
  ctx,
  checkpoint,
  { through = "", limit = 200, print = true, spool = false, seen, roomFilter = "" } = {},
) {
  let total = 0;
  let expectedThroughVector;
  while (true) {
    const page = await api.syncEventsCursor(ctx, {
      cursor: checkpoint.event,
      through,
      limit,
    });
    const proof = validateEventSyncPage(page, checkpoint, expectedThroughVector);
    expectedThroughVector ||= proof.through;
    for (const frame of page.frames) {
      if (emitFrame(ctx, frame, { print, spool, seen, roomFilter, source: "event-sync" })) total += 1;
    }
    checkpoint = {
      ...checkpoint,
      event: page.cursor,
      eventPosition: proof.next.floor,
      eventVector: proof.next,
      bootstrapped: true,
    };
    const deliveryIds = spool
      ? page.frames.map((frame) => frame.event?.event_id).filter(Boolean)
      : [];
    writeStreamCheckpoint(ctx, checkpoint, deliveryIds);
    if (deliveryIds.length) await flushPendingDeliveries(ctx);
    if (!page.has_more) return { checkpoint, total };
    through = "";
  }
}

async function syncAccountStream(
  ctx,
  checkpoint,
  { through = "", limit = 200, print = true, spool = false, seen, roomFilter = "" } = {},
) {
  let total = 0;
  let expectedThrough;
  while (true) {
    const page = await api.syncAccount(ctx, {
      cursor: checkpoint.account,
      through,
      limit,
    });
    const range = validateAccountSyncPage(page, checkpoint, expectedThrough);
    expectedThrough ??= range.through_position;
    for (const update of page.updates) {
      const frame = {
        type: "account.state",
        kind: update.kind,
        room_id: update.room_id || "",
        object_id: update.object_id || "",
        position: update.position,
        data: update.data || {},
        created_at: update.created_at,
      };
      if (emitFrame(ctx, frame, { print, spool, seen, roomFilter, source: "account-sync" })) total += 1;
    }
    checkpoint = {
      ...checkpoint,
      account: page.cursor,
      accountPosition: range.next_position,
      bootstrapped: true,
    };
    writeStreamCheckpoint(ctx, checkpoint);
    if (!page.has_more) return { checkpoint, total };
    through = "";
  }
}

async function syncDurableStreams(
  ctx,
  { eventThrough = "", accountThrough = "", limit = 200, print = true, spool = false, seen, roomFilter = "" } = {},
) {
  await flushPendingDeliveries(ctx);
  let checkpoint = readStreamCheckpoint(ctx);
  if (!checkpoint.bootstrapped) {
    checkpoint = await bootstrapStreamCheckpoint(ctx, { print, spool, roomFilter });
    eventThrough = "";
    accountThrough = "";
  }
  try {
    const events = await syncEventStream(ctx, checkpoint, {
      through: eventThrough,
      limit,
      print,
      spool,
      seen,
      roomFilter,
    });
    checkpoint = events.checkpoint;
    const account = await syncAccountStream(ctx, checkpoint, {
      through: accountThrough,
      limit,
      print,
      spool,
      seen,
      roomFilter,
    });
    return { checkpoint: account.checkpoint, total: events.total + account.total };
  } catch (error) {
    const code = error instanceof ApiError && error.body && typeof error.body === "object"
      ? error.body.code
      : "";
    if (!(error instanceof SyncIntegrityError) && !["resync_required", "invalid_cursor"].includes(code)) {
      throw error;
    }
    resetStreamCheckpoint(ctx);
    checkpoint = await bootstrapStreamCheckpoint(ctx, { print, spool, roomFilter });
    return { checkpoint, total: 0, rebuilt: true, reason: error.message };
  }
}

function waitForSocketClose(connection) {
  return new Promise((resolve) => {
    connection.socket.addEventListener("close", resolve, { once: true });
  });
}

async function roomIdsForListen(ctx, target) {
  if (!target || target === "all") {
    return [];
  }
  return [roomArg(ctx, target)];
}

async function cmdListen(ctx, args) {
  const { options, positionals } = parseOptions(args, ["once", "noSync", "spool", "noSpool"]);
  const target = positionals[0] || "all";
  await runDurableListen(ctx, {
    target,
    print: true,
    spool: options.noSpool ? false : options.spool !== false,
    once: Boolean(options.once),
    sync: !options.noSync,
    syncLimit: numberOption(options.syncLimit, 200, { min: 1, max: 500 }),
  });
}

async function runDurableListen(
  ctx,
  { target = "all", print = true, spool = false, once = false, sync = true, syncLimit = 200 } = {},
) {
  requireAuth(ctx);
  const listenerCtx = { ...ctx, syncScope: `listen:${target}` };
  let stopping = false;
  let activeConnection = null;
  const seen = new Set();
  const stop = () => {
    stopping = true;
    if (activeConnection) activeConnection.close(1000, "stopping");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let attempts = 0;
  while (!stopping) {
    try {
      const roomIds = await roomIdsForListen(listenerCtx, target);
      const roomFilter = target === "all" ? "" : roomIds[0];
      const connection = await openSocket(
        listenerCtx,
        roomIds,
        (frame) => emitFrame(listenerCtx, frame, { print, spool, seen, roomFilter }),
        { holdFrames: sync, acknowledgeFrames: spool },
      );
      activeConnection = connection;
      attempts = 0;
      let checkpoint = readStreamCheckpoint(listenerCtx);
      if (sync) {
        const synced = await syncDurableStreams(listenerCtx, {
          eventThrough: connection.hello.cursor || "",
          accountThrough: connection.hello.account_cursor || "",
          limit: syncLimit,
          print,
          spool,
          seen,
          roomFilter,
        });
        checkpoint = synced.checkpoint;
        if (synced.total && print) console.error(`reconciled ${synced.total} durable update(s).`);
        if (synced.rebuilt && print) console.error(`rebuilt sync checkpoint: ${synced.reason}`);
      }
      for (const frame of connection.release()) {
        if (
          frame?.type === "event" &&
          streamVectorIncludes(
            checkpoint.eventVector,
            frame.event?.stream_writer,
            frame.event?.stream_position,
          )
        ) {
          continue;
        }
        if (frame?.type === "account.state" && frame.position <= checkpoint.accountPosition) {
          continue;
        }
        const stored = emitFrame(listenerCtx, frame, { print, spool, seen, roomFilter });
        if (stored && spool && frame?.type === "event" && frame.event?.event_id) {
          connection.acknowledge([frame.event.event_id]);
        }
      }
      if (print) {
        const scope = target === "all" ? "all subscribed rooms" : `${roomIds.length} room(s)`;
        console.error(`listening to ${scope}. Ctrl+C to stop.`);
      }
      await waitForSocketClose(connection);
      activeConnection = null;
      if (once) break;
    } catch (error) {
      if (print) console.error(`listener error: ${error.message || error}`);
      if (once) throw error;
    }
    if (stopping || once) break;
    const delay = retryDelay(attempts);
    attempts += 1;
    if (print) console.error(`reconnecting in ${Math.round(delay / 1000)}s...`);
    await sleep(delay);
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}

function inboxPathForRoot(root) {
  return process.env.SILICON_INTERFACE_INBOX || path.join(stateDir(root), "inbox.jsonl");
}

function readPid(root = interfaceRoot()) {
  try {
    const value = fs.readFileSync(pidPath(root), "utf8").trim();
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopDaemonProcess({ root = interfaceRoot(), graceMs = 2_000 } = {}) {
  const pid = readPid(root);
  if (!pid || !isProcessAlive(pid)) {
    fs.rmSync(pidPath(root), { force: true });
    return { stopped: false, pid: pid || null };
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(25);
  if (isProcessAlive(pid)) {
    process.kill(pid, "SIGKILL");
    const killDeadline = Date.now() + 1_000;
    while (isProcessAlive(pid) && Date.now() < killDeadline) await sleep(25);
  }
  fs.rmSync(pidPath(root), { force: true });
  return { stopped: true, pid };
}

async function startDaemonProcess(
  ctx,
  {
    root = interfaceRoot(),
    scriptPath = fileURLToPath(import.meta.url),
    restart = false,
  } = {},
) {
  requireAuth(ctx);
  const existing = readPid(root);
  if (isProcessAlive(existing)) {
    if (!restart) return { started: false, alreadyRunning: true, pid: existing };
    await stopDaemonProcess({ root });
  } else {
    fs.rmSync(pidPath(root), { force: true });
  }
  fs.mkdirSync(stateDir(root), { recursive: true, mode: 0o700 });
  const stdout = fs.openSync(logPath("out.log", root), "a", 0o600);
  const stderr = fs.openSync(logPath("err.log", root), "a", 0o600);
  const env = {
    ...process.env,
    SILICON_INTERFACE_ROOT: root,
    SILICON_INTERFACE_API_BASE: ctx.config.apiBase,
    SILICON_INTERFACE_WS_BASE: ctx.config.wsBase,
    SILICON_INTERFACE_TIMEOUT_MS: String(ctx.config.requestTimeout),
  };
  delete env.SILICON_INTERFACE_KEY;
  delete env.SILICON_KEY;
  delete env.SILICON_INTERFACE_ACCESS_TOKEN;
  delete env.SILICON_INTERFACE_REFRESH_TOKEN;
  delete env.SILICON_INTERFACE_DEVICE_ID;
  if (ctx.config.siliconKey) env.SILICON_INTERFACE_KEY = ctx.config.siliconKey;
  if (ctx.config.accessToken) env.SILICON_INTERFACE_ACCESS_TOKEN = ctx.config.accessToken;
  if (ctx.config.refreshToken) env.SILICON_INTERFACE_REFRESH_TOKEN = ctx.config.refreshToken;
  if (ctx.config.deviceId) env.SILICON_INTERFACE_DEVICE_ID = ctx.config.deviceId;
  const child = spawn(
    process.execPath,
    [scriptPath, "--json", "daemon", "run", "--quiet"],
    {
      cwd: root,
      detached: true,
      env,
      stdio: ["ignore", stdout, stderr],
    },
  );
  child.unref();
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  fs.writeFileSync(pidPath(root), `${child.pid}\n`, { mode: 0o600 });
  return { started: true, alreadyRunning: false, pid: child.pid };
}

async function cmdDaemon(ctx, args) {
  const [sub = "status", ...rest] = args;
  if (sub === "run") {
    const { options } = parseOptions(rest, ["noSync", "noSpool", "once", "quiet"]);
    await runDurableListen(ctx, {
      target: "all",
      print: !options.quiet,
      spool: !options.noSpool,
      once: Boolean(options.once),
      sync: !options.noSync,
      syncLimit: numberOption(options.syncLimit, 200, { min: 1, max: 500 }),
    });
    return;
  }

  if (sub === "start" || sub === "restart") {
    const daemon = await startDaemonProcess(ctx, { restart: sub === "restart" });
    console.log(
      daemon.alreadyRunning
        ? `Silicon Interface daemon already running (PID ${daemon.pid}).`
        : `Silicon Interface daemon started (PID ${daemon.pid}).`,
    );
    console.log(`inbox: ${inboxPath()}`);
    console.log(`logs:  ${logPath("out.log")} / ${logPath("err.log")}`);
    return;
  }

  if (sub === "stop") {
    const stopped = await stopDaemonProcess();
    if (!stopped.stopped) {
      console.log("Silicon Interface daemon is not running.");
      return;
    }
    console.log(`Silicon Interface daemon stopped (PID ${stopped.pid}).`);
    return;
  }

  if (sub === "status") {
    const pid = readPid();
    const running = isProcessAlive(pid);
    const checkpoint = readStreamCheckpoint({ ...ctx, syncScope: "listen:all" });
    const value = {
      running,
      pid,
      state: statePath(),
      inbox: inboxPath(),
      logs: { stdout: logPath("out.log"), stderr: logPath("err.log") },
      cursors: {
        event: checkpoint.event,
        account: checkpoint.account,
        eventPosition: checkpoint.eventPosition,
        eventVector: checkpoint.eventVector,
        accountPosition: checkpoint.accountPosition,
      },
    };
    printResult(ctx, value, (data) => {
      console.log(`running: ${data.running ? "yes" : "no"}`);
      if (data.pid) console.log(`pid: ${data.pid}`);
      console.log(`event position: ${data.cursors.eventPosition}`);
      console.log(`account position: ${data.cursors.accountPosition}`);
      console.log(`inbox: ${data.inbox}`);
      console.log(`logs: ${data.logs.stdout} / ${data.logs.stderr}`);
    });
    return;
  }

  throw new UsageError("Usage: daemon <start|stop|restart|status|run>");
}

async function cmdInbox(ctx, args) {
  const [sub = "list", ...rest] = args;
  if (sub === "path") {
    console.log(inboxPath());
    return;
  }
  if (sub === "clear") {
    withFileLock(inboxPath(), () => {
      fs.rmSync(inboxPath(), { force: true });
      inboxDedupeCache.path = "";
      inboxDedupeCache.size = 0;
      inboxDedupeCache.keys = new Set();
    });
    console.log("Inbox cleared.");
    return;
  }
  if (sub === "list" || sub === "tail") {
    const { options } = parseOptions(rest);
    const limit = numberOption(options.limit, 50, { min: 1, max: 1000 });
    let lines = [];
    try {
      lines = fs.readFileSync(inboxPath(), "utf8").trim().split(/\r?\n/).filter(Boolean);
    } catch {
      lines = [];
    }
    const frames = lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { type: "raw", line };
      }
    });
    printResult(ctx, frames, (rows) => {
      for (const frame of rows) console.log(frameLine(frame));
    });
    return;
  }
  throw new UsageError("Usage: inbox [list|tail|clear|path] [--limit 50]");
}

function glassOperationKind(localKind) {
  if (localKind === "held-send") return "held_send";
  if (["event-send", "file-send", "album-send", "gif-send"].includes(localKind)) {
    return "event_send";
  }
  return "";
}

async function cmdOperations(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  const context = streamStateKey(ctx);
  if (sub === "path") {
    console.log(operationsPath());
    return;
  }
  if (sub === "list" || sub === "ls") {
    const { options } = parseOptions(rest, ["all"]);
    const rows = readOperationJournal().operations.filter(
      (row) => row.context === context && (options.all || row.status === "pending"),
    );
    printResult(ctx, rows, (operations) => {
      if (!operations.length) {
        console.log("No matching local operations.");
        return;
      }
      printRows(operations, [
        { label: "CLIENT", value: (row) => row.clientId },
        { label: "KIND", value: (row) => row.kind },
        { label: "STATUS", value: (row) => row.status },
        { label: "ROOM", value: (row) => row.intent?.roomId || row.result?.roomId || "" },
        { label: "UPDATED", value: (row) => shortTime(row.updatedAt) },
      ]);
    });
    return;
  }
  if (sub === "resolve") {
    const requested = rest[0] || "all";
    const rows = readOperationJournal().operations.filter(
      (row) =>
        row.context === context &&
        row.status === "pending" &&
        (requested === "all" || row.clientId === requested),
    );
    if (!rows.length) throw new UsageError(`No pending operation matches '${requested}'.`);
    const results = [];
    for (const row of rows) {
      const roomId = row.intent?.roomId;
      const kind = glassOperationKind(row.kind);
      if (!roomId || !kind) {
        results.push({ client_id: row.clientId, state: "local_only", detail: "Re-run the exact command." });
        continue;
      }
      try {
        let operation = await api.clientOperation(ctx, roomId, kind, row.clientId, false);
        if (operation.state === "succeeded") {
          const resolved = await attempt(() => api.clientOperation(ctx, roomId, kind, row.clientId, true));
          if (resolved.ok) operation = resolved.value;
        }
        if (["succeeded", "failed", "cancelled"].includes(operation.state)) {
          finishOperation(row, { roomId, operation });
        }
        results.push({ client_id: row.clientId, ...operation });
      } catch (error) {
        const code = error instanceof ApiError && typeof error.body === "object"
          ? error.body?.code
          : "";
        if (error instanceof ApiError && error.status === 404 && code === "operation_not_found") {
          results.push({ client_id: row.clientId, state: "not_found", detail: "Safe to re-run the exact command." });
          continue;
        }
        throw error;
      }
    }
    printResult(ctx, results, (operations) => {
      for (const operation of operations) {
        console.log(`${operation.client_id}: ${operation.state}${operation.resource_id ? ` ${operation.resource_id}` : ""}`);
      }
    });
    return;
  }
  if (sub === "prune") {
    const removed = updateOperationJournal((journal) => {
      const before = journal.operations.length;
      journal.operations = journal.operations.filter(
        (row) => row.context !== context || row.status === "pending",
      );
      return before - journal.operations.length;
    });
    printResult(ctx, { removed }, (value) => console.log(`Removed ${value.removed} completed operation(s).`));
    return;
  }
  throw new UsageError("Usage: operations list [--all] | resolve <client-id|all> | prune | path");
}

async function cmdDrafts(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const result = await api.drafts(ctx);
    const rows = Array.isArray(result) ? result : result.drafts || [];
    printResult(ctx, result, () => {
      if (!rows.length) console.log("No drafts.");
      else printRows(rows, [
        { label: "ROOM", value: (row) => row.room_id },
        { label: "VERSION", value: (row) => row.version },
        { label: "UPDATED", value: (row) => shortTime(row.updated_at) },
        { label: "TEXT", value: (row) => row.text || "" },
        { label: "FILES", value: (row) => row.attachments?.length || 0 },
      ]);
    });
    return;
  }
  if (sub === "show") {
    const roomId = roomArg(ctx, rest[0]);
    const result = await api.draft(ctx, roomId);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "put" || sub === "save") {
    const { options, positionals } = parseOptions(rest);
    const [roomToken, ...textParts] = positionals;
    const roomId = roomArg(ctx, roomToken);
    const payload = {
      text: String(options.text || textParts.join(" ")),
      attachments: asArray(options.attachment).map((value) => parseJsonValue(value, "--attachment")),
      reply_to_event_id: options.replyTo || "",
      origin_device: options.originDevice || ctx.config.deviceId || "cli",
    };
    if (options.baseVersion != null) payload.base_version = Number(options.baseVersion);
    if (options.contentUpdatedAt) payload.content_updated_at = options.contentUpdatedAt;
    const result = await api.putDraft(ctx, roomId, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "delete" || sub === "clear") {
    const { options, positionals } = parseOptions(rest);
    const roomId = roomArg(ctx, positionals[0]);
    const payload = {
      ...(options.baseVersion != null ? { base_version: Number(options.baseVersion) } : {}),
      origin_device: options.originDevice || ctx.config.deviceId || "cli",
    };
    const result = await api.deleteDraft(ctx, roomId, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: drafts list|show|put|delete ...");
}

async function cmdHeld(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const roomToken = rest.find((value) => !value.startsWith("--"));
    const result = roomToken
      ? await api.heldSends(ctx, roomArg(ctx, roomToken))
      : await api.heldSendsAll(ctx);
    const rows = Array.isArray(result) ? result : result.held_sends || [];
    printResult(ctx, result, () => {
      if (!rows.length) console.log("No held sends.");
      else printRows(rows, [
        { label: "HELD", value: (row) => row.held_send_id },
        { label: "ROOM", value: (row) => row.room_id },
        { label: "STATE", value: (row) => row.state },
        { label: "RELEASE", value: (row) => shortTime(row.release_at) },
        { label: "TEXT", value: (row) => row.content?.body || "" },
      ]);
    });
    return;
  }
  if (sub === "create") {
    const { options, positionals } = parseOptions(rest);
    const [roomToken, ...bodyParts] = positionals;
    const roomId = roomArg(ctx, roomToken);
    const body = String(options.body || bodyParts.join(" ")).trim();
    if (!body) throw new UsageError("Usage: held create <room> <text...> [--hold-seconds n]");
    const operation = beginOperation(ctx, "held-send", {
      roomId,
      body,
      replyTo: options.replyTo || "",
      holdSeconds: Number(options.holdSeconds || 0),
    });
    const payload = {
      type: "m.text",
      content: { body, client_id: operation.clientId },
      client_id: operation.clientId,
      ...(options.replyTo ? { reply_to_event_id: options.replyTo } : {}),
      ...(options.holdSeconds != null ? { hold_seconds: Number(options.holdSeconds) } : {}),
    };
    const result = await api.createHeldSend(ctx, roomId, payload);
    finishOperation(operation, { heldSendId: result.held_send_id, roomId });
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "patch" || sub === "update") {
    const { options, positionals } = parseOptions(rest);
    const [roomToken, heldId] = positionals;
    if (!heldId) throw new UsageError("Usage: held patch <room> <held_id> --base-version n [...]");
    const payload = { base_version: numberOption(options.baseVersion, 1, { min: 1 }) };
    if (options.body != null) payload.content = { body: options.body };
    if (options.clientId != null) payload.client_id = options.clientId;
    if (options.replyTo != null) payload.reply_to_event_id = options.replyTo;
    if (options.holdSeconds != null) payload.hold_seconds = Number(options.holdSeconds);
    if (options.delaySeconds != null) payload.delay_seconds = Number(options.delaySeconds);
    const result = await api.patchHeldSend(ctx, roomArg(ctx, roomToken), heldId, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (["cancel", "delete", "send-now", "send"].includes(sub)) {
    const [roomToken, heldId] = rest;
    if (!heldId) throw new UsageError(`Usage: held ${sub} <room> <held_id>`);
    const roomId = roomArg(ctx, roomToken);
    const result = sub === "cancel" || sub === "delete"
      ? await api.deleteHeldSend(ctx, roomId, heldId)
      : await api.sendHeldNow(ctx, roomId, heldId);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: held list|create|patch|send-now|cancel ...");
}

async function cmdChat(ctx, args) {
  const { options, positionals } = parseOptions(args, ["noHistory"]);
  const roomId = roomArg(ctx, positionals[0]);
  if (!options.noHistory) {
    const page = await api.historyPage(ctx, roomId, {
      limit: numberOption(options.limit, 25, { min: 1, max: 200 }),
    });
    for (const event of page.events || []) console.log(eventLine(event));
    if (page.events?.length) console.log("");
  }
  const connection = await openSocket(ctx, [roomId], (frame) => {
    if (frame.type === "event" && frame.room_id === roomId) console.log(eventLine(frame.event));
    else if (frame.room_id === roomId) console.log(frameLine(frame));
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  for await (const line of rl) {
    const body = line.trim();
    if (body === "/quit" || body === "/exit") break;
    if (body) {
      await sendEventReliable(ctx, roomId, { type: "m.text", content: { body } }, {
        signature: { roomId, type: "m.text", body },
      });
    }
    rl.prompt();
  }
  connection.close(1000, "chat closed");
}

async function cmdPresence(ctx, args) {
  requireAuth(ctx);
  if (ctx.config.siliconKey || !ctx.config.deviceId) {
    throw new UsageError("Presence requires a registered Carbon device session.");
  }
  const state = args[0];
  if (!["active", "inactive"].includes(state)) {
    throw new UsageError("Usage: presence <active|inactive>");
  }
  let settle;
  const responsePromise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const connection = await openSocket(ctx, [], (frame) => {
    if (frame?.type === "presence.ok") settle.resolve(frame);
    if (frame?.type === "presence.error") {
      settle.reject(new ProtocolError(`Presence update failed: ${frame.code || "unknown"}.`));
    }
    return false;
  });
  const timer = setTimeout(
    () => settle.reject(new TransportError("Presence acknowledgement timed out.")),
    Math.min(ctx.config.requestTimeout, 30_000),
  );
  connection.socket.addEventListener("close", () => {
    settle.reject(new TransportError("WebSocket closed before presence acknowledgement."));
  }, { once: true });
  try {
    connection.socket.send(JSON.stringify({ type: "presence", state }));
    const result = await responsePromise;
    printResult(ctx, result, (value) => console.log(`presence: ${value.state}`));
  } finally {
    globalThis.clearTimeout(timer);
    connection.close(1000, "presence updated");
  }
}

async function cmdActivity(ctx, args) {
  requireAuth(ctx);
  const [roomToken, state, value] = args;
  const roomId = roomArg(ctx, roomToken);
  if (!["typing", "uploading", "recording"].includes(state)) {
    throw new UsageError("Activity state must be typing, uploading, or recording.");
  }
  const result = await api.activity(ctx, roomId, state, asBool(value ?? "true"));
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdTyping(ctx, args) {
  requireAuth(ctx);
  const [roomToken, value = "on"] = args;
  const result = await api.typing(ctx, roomArg(ctx, roomToken), asBool(value));
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdRead(ctx, args) {
  requireAuth(ctx);
  const [roomToken, eventId] = args;
  if (!eventId) throw new UsageError("Usage: read <room> <event_id>");
  const result = await api.read(ctx, roomArg(ctx, roomToken), eventId);
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdProgress(ctx, args) {
  requireAuth(ctx);
  const { options, positionals } = parseOptions(args);
  const [roomToken, state, ...noteParts] = positionals;
  if (!state) throw new UsageError("Usage: progress <room> <state> [note...]");
  const payload = { state };
  const note = options.note || noteParts.join(" ");
  if (note) payload.note = note;
  if (options.group) payload.progress_group_id = options.group;
  if (options.pct) payload.progress_pct = Number(options.pct);
  if (options.summary) payload.summary = options.summary;
  const result = await api.progress(ctx, roomArg(ctx, roomToken), payload);
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdDelta(ctx, args) {
  requireAuth(ctx);
  const { options, positionals } = parseOptions(args);
  const [eventId, ...deltaParts] = positionals;
  if (!eventId || !deltaParts.length) throw new UsageError("Usage: delta <event_id> <text...>");
  const result = await api.appendDelta(ctx, eventId, deltaParts.join(" "), Number(options.seq || 0));
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdFinal(ctx, args) {
  requireAuth(ctx);
  const [eventId] = args;
  if (!eventId) throw new UsageError("Usage: final <event_id>");
  const result = await api.finalizeEvent(ctx, eventId);
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdTakeBack(ctx, args) {
  requireAuth(ctx);
  const [sub, ...rest] = args;
  if (sub === "requests" || sub === "request" || sub === "pending") {
    const { options } = parseOptions(rest);
    const rows = await api.takeBackRequests(ctx, options.status || "pending");
    printResult(ctx, rows, (requests) => {
      if (!requests.length) {
        console.log("No take-back requests.");
        return;
      }
      printRows(requests, [
        { label: "REQUEST", value: (r) => r.request_id },
        { label: "STATUS", value: (r) => r.status },
        { label: "ROOM", value: (r) => r.room_id },
        { label: "COUNT", value: (r) => r.message_count },
        { label: "REQUESTED", value: (r) => shortTime(r.requested_at) },
        {
          label: "PREVIEW",
          value: (r) =>
            (r.events || [])
              .map((event) => bodyText(event))
              .join(" | ")
              .slice(0, 120),
        },
      ]);
    });
    return;
  }
  if (sub === "complete" || sub === "replace") {
    const { options, positionals } = parseOptions(rest);
    const [requestId, ...bodyParts] = positionals;
    const body = String(options.body || bodyParts.join(" ")).trim();
    if (!requestId || !body) {
      throw new UsageError("Usage: take-back complete <request_id> <replacement text...>");
    }
    const result = await api.completeTakeBackRequest(ctx, requestId, { body });
    printResult(ctx, result, (data) => {
      console.log(`request: ${data.request.request_id} ${data.request.status}`);
      console.log(eventLine(data.replacement_event, data.request.room_id));
    });
    return;
  }
  const { options, positionals } = parseOptions(args, ["force"]);
  const [eventId] = positionals;
  if (!eventId) throw new UsageError("Usage: take-back <event_id> [--reason text] [--force]");
  const result = await api.takeBack(ctx, eventId, options.reason || "manual", Boolean(options.force));
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdDelete(ctx, args) {
  requireAuth(ctx);
  const [eventId] = args;
  if (!eventId) throw new UsageError("Usage: delete <event_id>");
  const result = await api.deleteEvent(ctx, eventId);
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdSearch(ctx, args) {
  requireAuth(ctx);
  const { options, positionals } = parseOptions(args, ["all"]);
  const q = positionals.join(" ").trim();
  if (!q && typeof options.cursor !== "string") {
    throw new UsageError("Usage: search <query...> | search --cursor <opaque-cursor>");
  }
  const pages = [];
  let cursor = typeof options.cursor === "string" ? options.cursor : "";
  do {
    const result = await api.search(
      ctx,
      cursor
        ? { cursor }
        : {
            q,
            room: options.room,
            sender_kind: options.senderKind,
            since: options.since,
            until: options.until,
            limit: numberOption(options.limit, 50, { min: 1, max: 100 }),
          },
    );
    pages.push(result);
    cursor = options.all && result.has_more ? result.cursor || "" : "";
  } while (cursor);
  const result = {
    results: pages.flatMap((page) => page.results || []),
    cursor: pages.at(-1)?.cursor || null,
    total: pages[0]?.total || 0,
    has_more: Boolean(pages.at(-1)?.has_more),
    pages: pages.length,
  };
  printResult(ctx, result, (data) => {
    for (const event of data.results || []) console.log(eventLine(event));
    console.error(`${data.results.length} result(s), total ${data.total}, has_more ${data.has_more}`);
    if (data.has_more && data.cursor) console.error(`cursor: ${data.cursor}`);
  });
}

function giphyKey(options = {}) {
  const key = String(
    options.apiKey || process.env.GIPHY_API_KEY || process.env.SILICON_INTERFACE_GIPHY_API_KEY || "",
  ).trim();
  if (!key) {
    throw new UsageError("GIF search needs GIPHY_API_KEY (or --api-key).");
  }
  return key;
}

async function giphyRequest(pathname, params, apiKey) {
  const query = new URLSearchParams({ api_key: apiKey, rating: "pg-13", ...params });
  const base = cleanBase(
    process.env.SILICON_INTERFACE_GIPHY_BASE || "https://api.giphy.com/v1/gifs",
  );
  const response = await fetch(`${base}/${pathname}?${query}`);
  if (!response.ok) throw new Error(`GIPHY request failed (${response.status}).`);
  return response.json();
}

function normalizeGif(item) {
  const images = item?.images || {};
  const download = images.downsized_medium || images.downsized || images.original || images.fixed_width;
  if (!item?.id || !download?.url) return null;
  return {
    id: item.id,
    title: String(item.title || "GIF").trim() || "GIF",
    pageUrl: item.url || `https://giphy.com/gifs/${item.id}`,
    downloadUrl: download.url,
    width: Number(download.width || 0),
    height: Number(download.height || 0),
  };
}

async function uploadBlobPresigned(upload, blob, filename) {
  if (upload.dev_mode) return;
  const FormDataCtor = globalThis.FormData;
  if (typeof FormDataCtor !== "function") {
    throw new UsageError("This Node runtime cannot upload GIFs. Use Node 22+.");
  }
  const form = new FormDataCtor();
  for (const [key, value] of Object.entries(upload.fields || {})) form.append(key, value);
  form.append("file", blob, filename);
  const response = await fetch(upload.url, { method: upload.method || "POST", body: form });
  if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
}

async function cmdGif(ctx, args) {
  requireAuth(ctx);
  const [sub, ...rest] = args;
  if (sub === "search") {
    const { options, positionals } = parseOptions(rest);
    const query = positionals.join(" ").trim();
    if (!query) throw new UsageError("Usage: gif search <query...> [--limit 12]");
    const limit = Math.max(1, Math.min(25, Number(options.limit || 12)));
    const payload = await giphyRequest("search", {
      q: query.slice(0, 50),
      limit: String(limit),
      bundle: "messaging_non_clips",
      remove_low_contrast: "true",
    }, giphyKey(options));
    const gifs = (payload.data || []).map(normalizeGif).filter(Boolean);
    printResult(ctx, { gifs }, (data) => printRows(data.gifs, [
      { label: "ID", value: (gif) => gif.id },
      { label: "TITLE", value: (gif) => gif.title },
      { label: "URL", value: (gif) => gif.pageUrl },
    ]));
    return;
  }
  if (sub === "send") {
    const { options, positionals } = parseOptions(rest);
    const [roomToken, gifId, ...captionParts] = positionals;
    if (!roomToken || !gifId) throw new UsageError("Usage: gif send <room> <gif_id> [caption...]");
    const roomId = roomArg(ctx, roomToken);
    const caption = captionParts.join(" ").trim();
    const operation = beginOperation(ctx, "gif-send", { roomId, gifId, caption });
    let gif = operation.gif || null;
    if (!gif) {
      const payload = await giphyRequest(encodeURIComponent(gifId), {}, giphyKey(options));
      gif = normalizeGif(payload.data);
      if (gif) updateOperation(operation, { gif });
    }
    if (!gif) throw new Error("GIPHY returned no usable GIF rendition.");
    const filename = `giphy-${gif.id}.gif`;
    const stagedPath = path.join(stateDir(), "uploads", `${operation.clientId}.gif`);
    let media = operation.mediaId ? { media_id: operation.mediaId } : null;
    if (!media) {
      if (!fs.existsSync(stagedPath)) {
        let download = await fetch(gif.downloadUrl, {
          signal: globalThis.AbortSignal.timeout(Math.max(ctx.config.requestTimeout, 60_000)),
        });
        if (!download.ok && operation.gif) {
          const refreshed = normalizeGif(
            (await giphyRequest(encodeURIComponent(gifId), {}, giphyKey(options))).data,
          );
          if (refreshed) {
            gif = refreshed;
            updateOperation(operation, { gif });
            download = await fetch(gif.downloadUrl, {
              signal: globalThis.AbortSignal.timeout(Math.max(ctx.config.requestTimeout, 60_000)),
            });
          }
        }
        if (!download.ok) throw new Error(`GIF download failed (${download.status}).`);
        atomicWriteBytes(stagedPath, Buffer.from(await download.arrayBuffer()));
      }
      try {
        media = await uploadMultipart(ctx, stagedPath, {
          roomId,
          mime: "image/gif",
          kind: "image",
          clientId: `upload_${operation.clientId}`,
        });
      } catch (error) {
        if (!(error instanceof ApiError) || ![404, 405].includes(error.status)) throw error;
      }
      if (media && (gif.width || gif.height)) {
        await api.mediaComplete(ctx, media.media_id, {
          width: gif.width || undefined,
          height: gif.height || undefined,
        });
      }
      if (!media) {
        const bytes = fs.readFileSync(stagedPath);
        const blob = new globalThis.Blob([bytes], { type: "image/gif" });
        const presigned = await api.presignUpload(ctx, {
          mime: "image/gif",
          size: blob.size,
          kind: "image",
          filename,
          room_id: roomId,
        });
        await uploadBlobPresigned(presigned.upload, blob, filename);
        if (!presigned.upload.dev_mode) {
          await api.mediaComplete(ctx, presigned.media.media_id, {
            width: gif.width || undefined,
            height: gif.height || undefined,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          });
        }
        media = presigned.media;
      }
      updateOperation(operation, { mediaId: media.media_id });
    }
    fs.rmSync(stagedPath, { force: true });
    const event = await sendMediaEvent(ctx, roomId, {
      type: "m.image",
      content: {
        media_id: media.media_id,
        mime: "image/gif",
        filename,
        ...(caption ? { caption } : {}),
        giphy_id: gif.id,
        giphy_url: gif.pageUrl,
        client_id: operation.clientId,
      },
    });
    finishOperation(operation, { mediaId: media.media_id, eventId: event.event_id, roomId });
    printResult(ctx, { gif, media, event }, (value) => {
      console.log(`gif: ${value.gif.id} ${value.gif.title}`);
      console.log(`media: ${value.media.media_id}`);
      console.log(eventLine(value.event));
    });
    return;
  }
  throw new UsageError("Usage: gif search <query...> | gif send <room> <gif_id> [caption...]");
}

async function hashFile(filePath, encoding = "hex") {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest(encoding);
}

function readFilePart(filePath, start, length) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, start + offset);
      if (!read) break;
      offset += read;
    }
    if (offset !== length) throw new Error(`Short read at byte ${start}.`);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

async function putMultipartPart(ctx, sessionId, partNumber, bytes, checksum) {
  let lastError;
  for (let attemptIndex = 0; attemptIndex <= REQUEST_MAX_RETRIES; attemptIndex += 1) {
    try {
      const signed = await api.signMultipartParts(ctx, sessionId, [
        { part_number: partNumber, checksum_sha256: checksum },
      ]);
      const target = signed?.parts?.[0];
      if (!target?.url) throw new ProtocolError(`Glass did not sign upload part ${partNumber}.`);
      if (target.part_number != null && target.part_number !== partNumber) {
        throw new ProtocolError(`Glass signed the wrong upload part for ${partNumber}.`);
      }
      if (target.checksum_sha256 && target.checksum_sha256 !== checksum) {
        throw new ProtocolError(`Glass changed the checksum for upload part ${partNumber}.`);
      }
      const response = await fetch(target.url, {
        method: target.method || "PUT",
        headers: {
          "Content-Length": String(bytes.length),
          "x-amz-checksum-sha256": checksum,
        },
        body: bytes,
        signal: globalThis.AbortSignal.timeout(Math.max(ctx.config.requestTimeout, 120_000)),
      });
      if (!response.ok) throw new TransportError(`Part ${partNumber} upload failed (${response.status}).`);
      return;
    } catch (error) {
      lastError = error;
      if (attemptIndex >= REQUEST_MAX_RETRIES) throw error;
      await sleep(retryDelay(attemptIndex));
    }
  }
  throw lastError;
}

async function uploadMultipart(ctx, filePath, { roomId, mime, kind, clientId }) {
  const stat = fs.statSync(filePath);
  const wholeSha256 = await hashFile(filePath);
  const session = await api.createMultipartUpload(ctx, {
    client_id: clientId.slice(0, 64),
    mime,
    size: stat.size,
    kind,
    filename: path.basename(filePath),
    room_id: roomId,
    sha256: wholeSha256,
  });
  if (!session?.media?.media_id) throw new ProtocolError("Glass returned no media identity.");
  if (session.dev_mode || session.state === "completed") return session.media;
  if (
    !Number.isSafeInteger(session.part_size) ||
    session.part_size < 1 ||
    !Number.isSafeInteger(session.part_count) ||
    session.part_count < 1 ||
    session.part_count !== Math.ceil(stat.size / session.part_size)
  ) {
    throw new ProtocolError("Glass returned an invalid multipart layout.");
  }
  let current = await api.multipartUpload(ctx, session.session_id);
  const uploaded = new Set((current.uploaded_parts || []).map((part) => part.part_number));
  for (let partNumber = 1; partNumber <= session.part_count; partNumber += 1) {
    if (uploaded.has(partNumber)) continue;
    const start = (partNumber - 1) * session.part_size;
    const length = Math.min(session.part_size, stat.size - start);
    const bytes = readFilePart(filePath, start, length);
    const checksum = createHash("sha256").update(bytes).digest("base64");
    await putMultipartPart(ctx, session.session_id, partNumber, bytes, checksum);
  }
  current = await api.multipartUpload(ctx, session.session_id);
  const partsByNumber = new Map();
  for (const part of current.uploaded_parts || []) {
    if (
      !Number.isSafeInteger(part?.part_number) ||
      part.part_number < 1 ||
      part.part_number > session.part_count ||
      partsByNumber.has(part.part_number) ||
      typeof part.etag !== "string" ||
      !part.etag ||
      typeof part.checksum_sha256 !== "string" ||
      !part.checksum_sha256
    ) {
      throw new ProtocolError("Glass returned a malformed uploaded-part proof.");
    }
    partsByNumber.set(part.part_number, {
      part_number: part.part_number,
      etag: part.etag,
      checksum_sha256: part.checksum_sha256,
    });
  }
  const parts = [...partsByNumber.values()].toSorted((a, b) => a.part_number - b.part_number);
  if (parts.length !== session.part_count) {
    throw new TransportError(
      `Object storage acknowledged ${parts.length}/${session.part_count} upload parts. Re-run the same command to resume.`,
    );
  }
  const completed = await api.completeMultipartUpload(ctx, session.session_id, {
    sha256: wholeSha256,
    parts,
  });
  return completed.media;
}

function attachmentsFromEvent(event) {
  if (!event || event.redacted_at) return [];
  const content = event.content && typeof event.content === "object" ? event.content : {};
  if (event.type === "m.album") {
    const items = Array.isArray(event.media_items)
      ? event.media_items
      : Array.isArray(content.items)
        ? content.items
        : [];
    return items
      .filter((item) => item && item.media_id)
      .map((item, index) => ({
        event_id: event.event_id,
        room_id: event.room,
        position: item.position ?? index,
        media_id: item.media_id,
        filename: item.filename || `attachment-${index + 1}`,
        mime: item.mime || "application/octet-stream",
        size: item.size,
        kind: item.kind,
        created_at: event.created_at,
      }));
  }
  if (!content.media_id) return [];
  return [{
    event_id: event.event_id,
    room_id: event.room,
    position: 0,
    media_id: content.media_id,
    filename: content.filename || content.caption || `${event.type.slice(2)}-${content.media_id}`,
    mime: content.mime || event.media_meta?.mime || "application/octet-stream",
    size: event.media_meta?.size,
    kind: event.media_meta?.kind || event.type.slice(2),
    created_at: event.created_at,
  }];
}

function safeFilename(value, fallback = "attachment") {
  const base = path.basename(String(value || fallback)).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_");
  return base.slice(0, 180) || fallback;
}

async function downloadMedia(ctx, mediaId, destination, { force = false } = {}) {
  const resolved = path.resolve(destination);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  let detail;
  if (fs.existsSync(resolved) && !force) {
    detail = await api.mediaDetail(ctx, mediaId);
    const expected = String(detail.media?.sha256 || "").toLowerCase();
    const sizeMatches = !detail.media?.size || fs.statSync(resolved).size === detail.media.size;
    if ((!expected && sizeMatches) || (expected && (await hashFile(resolved)).toLowerCase() === expected)) {
      return { path: resolved, media: detail.media, skipped: true, verified: Boolean(expected) };
    }
  }
  let response;
  for (let attemptIndex = 0; attemptIndex <= REQUEST_MAX_RETRIES; attemptIndex += 1) {
    if (!detail || attemptIndex > 0) detail = await api.mediaDetail(ctx, mediaId);
    const url = detail.attachment_url || detail.download_url;
    if (!url) {
      throw new ApiError(409, detail, `Media ${mediaId} is ${detail.media?.status || "not ready"}.`);
    }
    response = await fetch(url, {
      signal: globalThis.AbortSignal.timeout(Math.max(ctx.config.requestTimeout, 120_000)),
    }).catch((error) => {
      throw new TransportError(`Media download failed: ${error.message}`, error);
    });
    if (response.ok) break;
    if (attemptIndex >= REQUEST_MAX_RETRIES) {
      throw new TransportError(`Media download failed (${response.status}).`);
    }
    await sleep(retryDelay(attemptIndex));
  }
  const temp = `${resolved}.${process.pid}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp, { mode: 0o600 }));
    if (detail.media?.sha256) {
      const actual = await hashFile(temp);
      if (actual.toLowerCase() !== detail.media.sha256.toLowerCase()) {
        throw new SyncIntegrityError(`Checksum mismatch while downloading media ${mediaId}.`);
      }
    }
    fs.renameSync(temp, resolved);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { path: resolved, media: detail.media, skipped: false };
}

function mimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".json": "application/json",
    ".m4a": "audio/mp4",
    ".md": "text/markdown",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".txt": "text/plain",
    ".webm": "audio/webm",
    ".webp": "image/webp",
  };
  return map[ext] || "application/octet-stream";
}

async function uploadPresigned(upload, filePath, mime) {
  if (upload.dev_mode) return;
  const BlobCtor = globalThis.Blob;
  if (typeof BlobCtor !== "function") {
    throw new UsageError("This Node runtime cannot upload files. Use Node 22+ for FormData/Blob.");
  }
  const bytes = fs.readFileSync(filePath);
  await uploadBlobPresigned(upload, new BlobCtor([bytes], { type: mime }), path.basename(filePath));
}

async function cmdSendFile(ctx, args) {
  requireAuth(ctx);
  const { options, positionals } = parseOptions(args, ["legacy"]);
  const [roomToken, filePath, ...captionParts] = positionals;
  if (!filePath) throw new UsageError("Usage: send-file <room> <path> [caption...]");
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) throw new UsageError(`Not a file: ${resolvedPath}`);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new UsageError(`Not a file: ${resolvedPath}`);
  const mime = mimeFromPath(resolvedPath);
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "voice" : "file";
  const roomId = roomArg(ctx, roomToken);
  const caption = captionParts.join(" ").trim() || path.basename(resolvedPath);
  const operation = options.clientId
    ? {
        context: streamStateKey(ctx),
        signature: operationSignature("file-send-explicit", { roomId, clientId: options.clientId }),
        clientId: String(options.clientId),
      }
    : beginOperation(ctx, "file-send", {
        roomId,
        path: resolvedPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        caption,
      });
  let media = operation.mediaId ? { media_id: operation.mediaId } : null;
  if (!media) {
    if (!options.legacy) {
      try {
        media = await uploadMultipart(ctx, resolvedPath, {
          roomId,
          mime,
          kind,
          clientId: `upload_${operation.clientId}`,
        });
      } catch (error) {
        if (!(error instanceof ApiError) || ![404, 405].includes(error.status)) throw error;
      }
    }
    if (!media) {
      const presigned = await api.presignUpload(ctx, {
        mime,
        size: stat.size,
        kind,
        filename: path.basename(resolvedPath),
        room_id: roomId,
      });
      await uploadPresigned(presigned.upload, resolvedPath, mime);
      if (!presigned.upload.dev_mode) {
        await api.mediaComplete(ctx, presigned.media.media_id, {
          sha256: await hashFile(resolvedPath),
        });
      }
      media = presigned.media;
    }
    if (!options.clientId) updateOperation(operation, { mediaId: media.media_id });
  }
  const eventType = mime.startsWith("image/") ? "m.image" : kind === "voice" ? "m.voice" : "m.file";
  const event = await sendMediaEvent(ctx, roomId, {
    type: eventType,
    content: {
      media_id: media.media_id,
      mime,
      filename: path.basename(resolvedPath),
      caption,
      client_id: operation.clientId,
    },
  });
  if (!options.clientId) {
    finishOperation(operation, { mediaId: media.media_id, eventId: event.event_id, roomId });
  }
  printResult(ctx, { media, event, client_id: operation.clientId }, (value) => {
    console.log(`media: ${value.media.media_id}`);
    console.log(eventLine(value.event));
  });
}

async function cmdSendFiles(ctx, args) {
  requireAuth(ctx);
  const { options, positionals } = parseOptions(args, ["legacy"]);
  const [roomToken, ...filePaths] = positionals;
  if (filePaths.length < 2 || filePaths.length > 10) {
    throw new UsageError("Usage: send-files <room> <2-10 paths...> [--caption text]");
  }
  const roomId = roomArg(ctx, roomToken);
  const files = filePaths.map((filePath) => {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) throw new UsageError(`Not a file: ${resolvedPath}`);
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) throw new UsageError(`Not a file: ${resolvedPath}`);
    const mime = mimeFromPath(resolvedPath);
    return {
      resolvedPath,
      stat,
      mime,
      kind: mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "voice" : "file",
    };
  });
  const caption = String(options.caption || "").trim();
  const operation = options.clientId
    ? {
        context: streamStateKey(ctx),
        signature: operationSignature("album-send-explicit", { roomId, clientId: options.clientId }),
        clientId: String(options.clientId),
      }
    : beginOperation(ctx, "album-send", {
        roomId,
        caption,
        replyTo: options.replyTo || "",
        files: files.map(({ resolvedPath, stat }) => ({
          path: resolvedPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })),
      });
  const mediaIds = [...(operation.mediaIds || [])];
  for (let index = mediaIds.length; index < files.length; index += 1) {
    const file = files[index];
    let media = null;
    if (!options.legacy) {
      try {
        media = await uploadMultipart(ctx, file.resolvedPath, {
          roomId,
          mime: file.mime,
          kind: file.kind,
          clientId: `upload_${index}_${operation.clientId}`,
        });
      } catch (error) {
        if (!(error instanceof ApiError) || ![404, 405].includes(error.status)) throw error;
      }
    }
    if (!media) {
      const presigned = await api.presignUpload(ctx, {
        mime: file.mime,
        size: file.stat.size,
        kind: file.kind,
        filename: path.basename(file.resolvedPath),
        room_id: roomId,
      });
      await uploadPresigned(presigned.upload, file.resolvedPath, file.mime);
      if (!presigned.upload.dev_mode) {
        await api.mediaComplete(ctx, presigned.media.media_id, {
          sha256: await hashFile(file.resolvedPath),
        });
      }
      media = presigned.media;
    }
    mediaIds.push(media.media_id);
    if (!options.clientId) updateOperation(operation, { mediaIds: [...mediaIds] });
  }
  const content = {
    items: files.map((file, index) => ({
      media_id: mediaIds[index],
      filename: path.basename(file.resolvedPath).slice(0, 255),
    })),
    caption,
    client_id: operation.clientId,
  };
  const event = await sendMediaEvent(ctx, roomId, {
    type: "m.album",
    content,
    ...(options.replyTo ? { reply_to_event_id: options.replyTo } : {}),
  });
  if (!options.clientId) finishOperation(operation, { mediaIds, eventId: event.event_id, roomId });
  printResult(ctx, { media_ids: mediaIds, event, client_id: operation.clientId }, (value) => {
    console.log(`media: ${value.media_ids.join(", ")}`);
    console.log(eventLine(value.event));
  });
}

async function cmdAttachments(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const { options, positionals } = parseOptions(rest, ["all", "resolve"]);
    const roomId = roomArg(ctx, positionals[0]);
    const history = await fetchRoomHistory(ctx, roomId, {
      all: Boolean(options.all),
      limit: numberOption(options.limit, options.all ? 200 : 50, { min: 1, max: 200 }),
    });
    const attachments = history.events.flatMap(attachmentsFromEvent);
    if (options.resolve) {
      for (const attachment of attachments) {
        attachment.media = await api.mediaDetail(ctx, attachment.media_id);
      }
    }
    printResult(ctx, attachments, (rows) => {
      if (!rows.length) {
        console.log("No attachments.");
        return;
      }
      printRows(rows, [
        { label: "EVENT", value: (row) => row.event_id },
        { label: "MEDIA", value: (row) => row.media_id },
        { label: "MIME", value: (row) => row.mime },
        { label: "SIZE", value: (row) => row.size ?? row.media?.media?.size ?? "" },
        { label: "FILE", value: (row) => row.filename },
      ]);
    });
    return;
  }
  if (sub === "download") {
    const { options, positionals } = parseOptions(rest, ["all", "force"]);
    const [roomToken, destination = "."] = positionals;
    const roomId = roomArg(ctx, roomToken);
    const history = await fetchRoomHistory(ctx, roomId, {
      all: Boolean(options.all),
      limit: numberOption(options.limit, options.all ? 200 : 50, { min: 1, max: 200 }),
    });
    const attachments = history.events.flatMap(attachmentsFromEvent);
    const directory = path.resolve(destination);
    fs.mkdirSync(directory, { recursive: true });
    const results = [];
    for (const attachment of attachments) {
      const prefix = `${attachment.event_id}-${String(attachment.position).padStart(2, "0")}`;
      const filename = `${prefix}-${safeFilename(attachment.filename, attachment.media_id)}`;
      const result = await downloadMedia(ctx, attachment.media_id, path.join(directory, filename), {
        force: Boolean(options.force),
      });
      results.push({ ...attachment, ...result });
    }
    printResult(ctx, results, (rows) => {
      for (const row of rows) console.log(`${row.skipped ? "exists" : "saved"}: ${row.path}`);
    });
    return;
  }
  throw new UsageError("Usage: attachments list <room> [--all] | attachments download <room> [dir] [--all]");
}

async function cmdMedia(ctx, args) {
  requireAuth(ctx);
  const [sub, mediaId, ...rest] = args;
  if (!mediaId) throw new UsageError("Usage: media show|download <media_id> [path]");
  if (sub === "show") {
    const result = await api.mediaDetail(ctx, mediaId);
    printResult(ctx, result, (data) => printJson(data));
    return;
  }
  if (sub === "download") {
    const { options, positionals } = parseOptions(rest, ["force"]);
    const detail = await api.mediaDetail(ctx, mediaId);
    const fallback = `${mediaId}${path.extname(detail.media?.filename || "")}`;
    const destination = positionals[0] || safeFilename(detail.media?.filename, fallback);
    const result = await downloadMedia(ctx, mediaId, destination, { force: Boolean(options.force) });
    printResult(ctx, result, (value) => console.log(`${value.skipped ? "exists" : "saved"}: ${value.path}`));
    return;
  }
  throw new UsageError("Usage: media show|download <media_id> [path]");
}

async function cmdTts(ctx, args) {
  requireAuth(ctx);
  const { options, positionals } = parseOptions(args);
  const text = positionals.join(" ").trim();
  if (!text) throw new UsageError("Usage: tts <text...> [--room room_id]");
  const result = await api.tts(ctx, {
    text,
    voice: options.voice,
    scene: options.scene,
    style: options.style,
    room_id: options.room || ctx.config.defaultRoom || undefined,
  });
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdStt(ctx, args) {
  requireAuth(ctx);
  const { options, positionals } = parseOptions(args);
  const [mediaId] = positionals;
  if (!mediaId) throw new UsageError("Usage: stt <media_id> [--language code]");
  const result = await api.stt(ctx, { media_id: mediaId, language: options.language });
  printResult(ctx, result, (data) => printJson(data));
}

async function cmdCrons(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const { options } = parseOptions(rest, ["mine"]);
    const rows = await api.crons(ctx, {
      mine: Boolean(options.mine),
      for: options.for,
      setupBy: options.setupBy,
    });
    printResult(ctx, rows, (crons) => {
      if (!crons.length) {
        console.log("No crons.");
        return;
      }
      printRows(crons, [
        { label: "CRON", value: (c) => c.cron_id },
        { label: "ACTIVE", value: (c) => c.is_active },
        { label: "TRIGGER", value: (c) => c.trigger },
        { label: "NEXT", value: (c) => c.next_run || "" },
        { label: "TARGETS", value: (c) => c.for_targets.map((t) => `${t.kind}:${t.id}`).join(",") },
        { label: "TASK", value: (c) => c.task },
      ]);
    });
    return;
  }
  if (sub === "show") {
    const [cronId] = rest;
    if (!cronId) throw new UsageError("Usage: crons show <cron_id>");
    const cron = await api.cron(ctx, cronId);
    printResult(ctx, cron, (data) => printJson(data));
    return;
  }
  if (sub === "create") {
    const { options } = parseOptions(rest);
    if (!options.trigger) throw new UsageError("Missing --trigger.");
    if (!options.task) throw new UsageError("Missing --task.");
    const targets = await normalizeTargets(ctx, asArray(options.target));
    if (!targets.length) throw new UsageError("Pass at least one --target kind:id.");
    const result = await api.createCron(ctx, {
      trigger: options.trigger,
      for_targets: targets,
      task: options.task,
    });
    printResult(ctx, result, (data) => {
      console.log(`cron: ${data.cron.cron_id}`);
      if (data.conflicts?.length) console.log(`conflicts: ${data.conflicts.length}`);
    });
    return;
  }
  if (sub === "patch" || sub === "update") {
    const { options, positionals } = parseOptions(rest);
    const [cronId] = positionals;
    if (!cronId) throw new UsageError("Usage: crons patch <cron_id> [--trigger expr] [--task text]");
    const patch = {};
    if (options.trigger) patch.trigger = options.trigger;
    if (options.task) patch.task = options.task;
    if (options.active != null) patch.is_active = asBool(options.active);
    if (!Object.keys(patch).length) throw new UsageError("No cron fields to patch.");
    const result = await api.patchCron(ctx, cronId, patch);
    printResult(ctx, result, (data) => printJson(data));
    return;
  }
  if (sub === "delete" || sub === "rm") {
    const [cronId] = rest;
    if (!cronId) throw new UsageError("Usage: crons delete <cron_id>");
    const result = await api.deleteCron(ctx, cronId);
    printResult(ctx, result || { ok: true }, (data) => printJson(data || { ok: true }));
    return;
  }
  throw new UsageError(`Unknown crons command '${sub}'.`);
}

async function cmdSessions(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const rows = await api.sessions(ctx);
    printResult(ctx, rows, (data) => printJson(data));
    return;
  }
  if (sub === "new") {
    const [roomToken, ...summaryParts] = rest;
    const result = await api.sessionNew(ctx, roomArg(ctx, roomToken), summaryParts.join(" "));
    printResult(ctx, result, (data) => printJson(data));
    return;
  }
  if (sub === "end") {
    const [sessionId, ...summaryParts] = rest;
    if (!sessionId) throw new UsageError("Usage: sessions end <session_id> [summary...]");
    const result = await api.sessionEnd(ctx, sessionId, summaryParts.join(" "));
    printResult(ctx, result, (data) => printJson(data));
    return;
  }
  throw new UsageError(`Unknown sessions command '${sub}'.`);
}

async function cmdContacts(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const rows = await api.contacts(ctx);
    printResult(ctx, rows, (contacts) => {
      if (!contacts.length) {
        console.log("No contacts.");
        return;
      }
      printRows(contacts, [
        { label: "ID", value: (c) => c.id },
        { label: "TARGET", value: (c) => `${c.target_kind}:${c.target_id}` },
        { label: "NAME", value: (c) => c.name },
        { label: "NOTE", value: (c) => c.note || "" },
      ]);
    });
    return;
  }
  if (sub === "save") {
    const { options, positionals } = parseOptions(rest);
    const [kind, id] = positionals;
    if (kind !== "carbon" && kind !== "silicon") {
      throw new UsageError("Usage: contacts save <carbon|silicon> <id> [--name n] [--note n]");
    }
    if (!id) throw new UsageError("Missing contact target id.");
    const result = await api.saveContact(ctx, {
      target_kind: kind,
      target_id: id,
      name: options.name,
      note: options.note,
    });
    printResult(ctx, result, (data) => printJson(data));
    return;
  }
  if (sub === "update") {
    const { options, positionals } = parseOptions(rest);
    const [id] = positionals;
    if (!id) throw new UsageError("Usage: contacts update <id> [--name n] [--note n]");
    const patch = {};
    if (options.name != null) patch.name = options.name;
    if (options.note != null) patch.note = options.note;
    const result = await api.updateContact(ctx, id, patch);
    printResult(ctx, result, (data) => printJson(data));
    return;
  }
  if (sub === "delete" || sub === "rm") {
    const [id] = rest;
    if (!id) throw new UsageError("Usage: contacts delete <id>");
    const result = await api.deleteContact(ctx, id);
    printResult(ctx, result || { ok: true }, (data) => printJson(data || { ok: true }));
    return;
  }
  throw new UsageError(`Unknown contacts command '${sub}'.`);
}

async function cmdSiliconBrowser(ctx, args) {
  requireAuth(ctx);
  const [sub = "open", siliconId] = args;
  if (sub !== "open" || !siliconId) {
    throw new UsageError("Usage: browser-session open <silicon-id>");
  }
  const result = await api.openSiliconBrowser(ctx, siliconId);
  printResult(ctx, result, (value) => console.log(value.viewer_url || JSON.stringify(value)));
}

async function cmdTakeBackPolicy(ctx, args) {
  requireAuth(ctx);
  const [sub = "show", ...rest] = args;
  if (sub === "show" || sub === "get") {
    const result = await api.takeBackPolicy(ctx);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "set" || sub === "patch") {
    const { options } = parseOptions(rest);
    const payload = jsonBodyOption(options) || {};
    if (options.enabled != null) payload.enabled = asBool(options.enabled);
    if (options.unreadThreshold != null) {
      payload.unread_threshold_msgs = integerValue(options.unreadThreshold, "--unread-threshold");
    }
    if (options.unreadDuration != null) {
      payload.unread_duration_secs = integerValue(options.unreadDuration, "--unread-duration");
    }
    if (!Object.keys(payload).length) {
      throw new UsageError(
        "Usage: take-back-policy set [--enabled bool] [--unread-threshold n] [--unread-duration seconds]",
      );
    }
    const result = await api.patchTakeBackPolicy(ctx, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: take-back-policy show|set");
}

function teamSlug(args, usage) {
  const slug = args[0];
  if (!slug) throw new UsageError(usage);
  return slug;
}

async function cmdTeams(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const result = await api.teams(ctx);
    printResult(ctx, result, (rows) => {
      if (!rows.length) return console.log("No teams.");
      printRows(rows, [
        { label: "SLUG", value: (row) => row.slug },
        { label: "NAME", value: (row) => row.name },
        { label: "ROLE", value: (row) => row.role || row.membership?.role || "" },
      ]);
    });
    return;
  }
  if (sub === "show") {
    const result = await api.team(ctx, teamSlug(rest, "Usage: teams show <slug>"));
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "create") {
    const { options, positionals } = parseOptions(rest);
    const payload = jsonBodyOption(options) || {
      name: positionals.join(" ").trim(),
      ...(options.slug ? { slug: options.slug } : {}),
    };
    if (!payload.name) throw new UsageError("Usage: teams create <name...> [--slug slug]");
    const result = await api.createTeam(ctx, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "patch" || sub === "update") {
    const { options, positionals } = parseOptions(rest);
    const slug = teamSlug(positionals, "Usage: teams patch <slug> [--name text] [--data JSON]");
    const payload = jsonBodyOption(options) || {};
    if (options.name != null) payload.name = options.name;
    if (options.newSlug != null) payload.slug = options.newSlug;
    if (!Object.keys(payload).length) throw new UsageError("No team fields to patch.");
    const result = await api.patchTeam(ctx, slug, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "logo") {
    const [slug, rawPath] = rest;
    if (!slug || !rawPath) throw new UsageError("Usage: teams logo <slug> <file>");
    const filePath = path.resolve(rawPath);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new UsageError(`Not a file: ${filePath}`);
    }
    const result = await api.uploadTeamLogo(ctx, slug, filePath);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (["members", "silicons", "reactivity", "structure", "invites"].includes(sub)) {
    const { options, positionals } = parseOptions(rest);
    const slug = teamSlug(positionals, `Usage: teams ${sub} <slug>`);
    let result;
    if (sub === "members") result = await api.teamMembers(ctx, slug);
    if (sub === "silicons") result = await api.teamSilicons(ctx, slug);
    if (sub === "reactivity") {
      const bucket = String(options.bucket || "");
      if (bucket && !["hour", "day", "month"].includes(bucket)) {
        throw new UsageError("--bucket must be hour, day, or month.");
      }
      result = bucket
        ? await api.teamReactivitySeries(ctx, slug, bucket)
        : await api.teamReactivity(ctx, slug);
    }
    if (sub === "structure") {
      result = await api.teamStructure(ctx, slug);
      if (options.output) {
        const output = atomicWriteText(options.output, result.svg || "");
        printResult(ctx, { ...result, output }, (value) => console.log(value.output));
        return;
      }
    }
    if (sub === "invites") result = await api.teamInvites(ctx, slug);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "invite-create") {
    const { options, positionals } = parseOptions(rest);
    const slug = teamSlug(positionals, "Usage: teams invite-create <slug> [options]");
    const payload = jsonBodyOption(options) || {};
    for (const [option, field] of [
      ["scope", "scope"],
      ["siliconId", "silicon_id"],
      ["channel", "channel"],
      ["email", "email_target"],
      ["role", "role"],
    ]) {
      if (options[option] != null) payload[field] = options[option];
    }
    if (options.maxUses != null) payload.max_uses = integerValue(options.maxUses, "--max-uses", { min: 1 });
    if (options.ttlMinutes != null) {
      payload.ttl_minutes = integerValue(options.ttlMinutes, "--ttl-minutes", { min: 1 });
    }
    const result = await api.createTeamInvite(ctx, slug, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "invite-disable") {
    const [slug, inviteId] = rest;
    if (!slug || !inviteId) throw new UsageError("Usage: teams invite-disable <slug> <invite-id>");
    const result = await api.disableTeamInvite(ctx, slug, inviteId);
    printResult(ctx, result || { ok: true }, (value) => printJson(value || { ok: true }));
    return;
  }
  if (sub === "invitees") {
    const { options, positionals } = parseOptions(rest);
    const slug = teamSlug(positionals, "Usage: teams invitees <slug> [--offset n] [--limit n]");
    const offset = options.offset == null ? 0 : integerValue(options.offset, "--offset");
    const limit = options.limit == null ? 50 : integerValue(options.limit, "--limit", { min: 1 });
    const result = await api.teamInvitees(ctx, slug, offset, limit);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "billing") {
    const result = await api.teamBilling(ctx, teamSlug(rest, "Usage: teams billing <slug>"));
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "plan") {
    const { options, positionals } = parseOptions(rest);
    const slug = teamSlug(positionals, "Usage: teams plan <slug> --amount-cents n [--currency USD]");
    if (options.amountCents == null) throw new UsageError("Missing --amount-cents.");
    const payload = {
      amount_cents: integerValue(options.amountCents, "--amount-cents"),
      currency: String(options.currency || "USD").toUpperCase(),
    };
    const result = await api.setTeamPlan(ctx, slug, payload);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "addon") {
    const { options, positionals } = parseOptions(rest);
    const slug = teamSlug(positionals, "Usage: teams addon <slug> --label text --amount-cents n");
    if (!options.label || options.amountCents == null) {
      throw new UsageError("Missing --label or --amount-cents.");
    }
    const result = await api.addTeamAddon(ctx, slug, {
      label: options.label,
      amount_cents: integerValue(options.amountCents, "--amount-cents"),
      recurring: options.recurring == null ? true : asBool(options.recurring),
    });
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "roll") {
    const result = await api.rollTeamCycle(ctx, teamSlug(rest, "Usage: teams roll <slug>"));
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "checkout") {
    const { options, positionals } = parseOptions(rest);
    const slug = teamSlug(positionals, "Usage: teams checkout <slug> [--cycle-id n] [--cycle-ids 1,2]");
    const cycleIds = asArray(options.cycleIds)
      .flatMap((value) => String(value).split(","))
      .filter(Boolean)
      .map((value) => integerValue(value, "--cycle-ids", { min: 1 }));
    const payload = {
      return_url: options.returnUrl || "",
      ...(options.cycleId != null
        ? { cycle_id: integerValue(options.cycleId, "--cycle-id", { min: 1 }) }
        : {}),
      ...(cycleIds.length ? { cycle_ids: cycleIds } : {}),
    };
    const intent = { slug, ...payload };
    const operation = beginOperation(ctx, "team-checkout", intent);
    const result = await api.teamCheckout(ctx, slug, {
      ...payload,
      idempotency_key: options.idempotencyKey || operation.clientId,
    });
    finishOperation(operation, result);
    printResult(ctx, result, (value) => console.log(value.checkout_url || JSON.stringify(value)));
    return;
  }
  throw new UsageError(`Unknown teams command '${sub}'.`);
}

async function cmdInvites(ctx, args) {
  const [sub = "show", ...rest] = args;
  if (sub === "show" || sub === "info") {
    const [token] = rest;
    if (!token) throw new UsageError("Usage: invites show <token>");
    const result = await api.invite(ctx, token);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "accept") {
    const { options, positionals } = parseOptions(rest);
    const [token] = positionals;
    if (!token) throw new UsageError("Usage: invites accept <token> [--code code]");
    const result = await api.acceptInvite(ctx, token, options.code ? { code: options.code } : {});
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "verify-start") {
    const [token, email] = rest;
    if (!token || !email) throw new UsageError("Usage: invites verify-start <token> <email>");
    const result = await api.inviteVerifyEmailStart(ctx, token, email);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "verify") {
    const [token, email, code] = rest;
    if (!token || !email || !code) throw new UsageError("Usage: invites verify <token> <email> <code>");
    const result = await api.inviteVerifyEmailCheck(ctx, token, email, code);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: invites show|accept|verify-start|verify");
}

async function cmdModeration(ctx, args) {
  requireAuth(ctx);
  const [sub = "restrictions", ...rest] = args;
  if (sub === "restrictions") {
    const result = await api.moderationRestrictions(ctx);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "appeals") {
    const result = await api.moderationAppeals(ctx);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "appeal") {
    const { options, positionals } = parseOptions(rest);
    const [restrictionId, ...reasonParts] = positionals;
    const reason = String(options.reason || reasonParts.join(" ")).trim();
    if (!restrictionId || !reason) {
      throw new UsageError("Usage: moderation appeal <restriction-id> <reason...>");
    }
    const result = await api.submitModerationAppeal(ctx, {
      restriction_id: restrictionId,
      reason,
    });
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "report") {
    const { options, positionals } = parseOptions(rest);
    const [kind, targetId] = positionals;
    if (!["carbon", "silicon"].includes(kind) || !targetId || !options.event) {
      throw new UsageError(
        "Usage: moderation report <carbon|silicon> <id> --event event-id --reason spam [--details text]",
      );
    }
    const reason = String(options.reason || "other");
    if (!["spam", "harassment", "inappropriate", "other"].includes(reason)) {
      throw new UsageError("--reason must be spam, harassment, inappropriate, or other.");
    }
    const intent = { kind, targetId, eventId: options.event, reason, details: options.details || "" };
    const operation = beginOperation(ctx, "moderation-report", intent);
    const result = await api.reportMessage(ctx, {
      target_kind: kind,
      target_id: targetId,
      reason,
      details: options.details || "",
      event_id: options.event,
      client_id: options.clientId || operation.clientId,
    });
    finishOperation(operation, result);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: moderation restrictions|appeals|appeal|report");
}

async function cmdPush(ctx, args) {
  requireAuth(ctx);
  const [sub = "vapid-key", ...rest] = args;
  if (sub === "vapid-key") {
    const result = await api.pushVapidKey(ctx);
    printResult(ctx, result, (value) => console.log(value.public_key || JSON.stringify(value)));
    return;
  }
  if (sub === "subscribe") {
    const { options } = parseOptions(rest);
    const result = await api.pushSubscribe(ctx, jsonBodyOption(options, { required: true }));
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "unsubscribe") {
    const endpoint = rest.join(" ").trim();
    if (!endpoint) throw new UsageError("Usage: push unsubscribe <endpoint>");
    const result = await api.pushUnsubscribe(ctx, endpoint);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: push vapid-key|subscribe|unsubscribe");
}

async function cmdChallenge(ctx, args) {
  requireAuth(ctx);
  const [sub, ...rest] = args;
  if (sub === "push") {
    const [token] = rest;
    if (!token) throw new UsageError("Usage: challenge push <token>");
    const result = await api.requestAbuseChallengePush(ctx, token);
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  if (sub === "answer") {
    const { options } = parseOptions(rest);
    if (!options.token || !options.type || !options.answer) {
      throw new UsageError("Usage: challenge answer --token t --type push|captcha --answer value");
    }
    if (!["push", "captcha"].includes(String(options.type))) {
      throw new UsageError("--type must be push or captcha.");
    }
    const result = await api.answerAbuseChallenge(ctx, {
      token: options.token,
      type: options.type,
      answer: options.answer,
    });
    printResult(ctx, result, (value) => printJson(value));
    return;
  }
  throw new UsageError("Usage: challenge push|answer");
}

async function cmdAnnouncements(ctx) {
  requireAuth(ctx);
  const result = await api.announcements(ctx);
  printResult(ctx, result, (value) => printJson(value));
}

async function cmdCost(ctx, args) {
  requireAuth(ctx);
  const [sub = "summary"] = args;
  const result = sub === "summary"
    ? await api.costSummary(ctx)
    : sub === "recent"
      ? await api.costRecent(ctx)
      : null;
  if (result == null) throw new UsageError("Usage: cost summary|recent");
  printResult(ctx, result, (value) => printJson(value));
}

function glassHeaders(options) {
  const headers = {};
  for (const item of asArray(options.header)) {
    const raw = String(item);
    const index = raw.indexOf(":");
    if (index < 1 || /[\r\n]/.test(raw)) throw new UsageError("--header must be 'Name: value'.");
    headers[raw.slice(0, index).trim()] = raw.slice(index + 1).trim();
  }
  if (options.contentType) headers["Content-Type"] = String(options.contentType);
  return headers;
}

async function glassRequestBody(options) {
  const files = asArray(options.file);
  const fields = asArray(options.form);
  const bodyModes = [
    files.length || fields.length,
    options.data != null || options.dataFile != null,
    options.rawBody != null,
  ].filter(Boolean).length;
  if (bodyModes > 1) {
    throw new UsageError(
      "Use exactly one body mode: JSON --data/--data-file, multipart --form/--file, or --raw-body.",
    );
  }
  if (files.length || fields.length) {
    const form = new globalThis.FormData();
    for (const item of fields) {
      const index = String(item).indexOf("=");
      if (index < 1) throw new UsageError("--form must be key=value.");
      form.append(String(item).slice(0, index), String(item).slice(index + 1));
    }
    for (const item of files) {
      const index = String(item).indexOf("=");
      if (index < 1) throw new UsageError("--file must be field=/path/to/file.");
      const field = String(item).slice(0, index);
      const filePath = path.resolve(String(item).slice(index + 1));
      if (!fs.existsSync(filePath)) throw new UsageError(`Not a file: ${filePath}`);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new UsageError(`Not a file: ${filePath}`);
      const type = mimeFromPath(filePath);
      const blob = typeof fs.openAsBlob === "function"
        ? await fs.openAsBlob(filePath, { type })
        : new globalThis.Blob([fs.readFileSync(filePath)], { type });
      form.append(
        field,
        blob,
        path.basename(filePath),
      );
    }
    return { body: form, bodyType: "form" };
  }
  if (options.rawBody != null) {
    const filePath = options.rawBody === "-" ? "" : path.resolve(String(options.rawBody));
    if (filePath && !fs.existsSync(filePath)) throw new UsageError(`Not a file: ${filePath}`);
    const body = options.rawBody === "-" ? fs.readFileSync(0) : fs.readFileSync(filePath);
    return { body, bodyType: "raw" };
  }
  return { body: jsonBodyOption(options), bodyType: "json" };
}

async function cmdGlass(ctx, args) {
  const verb = args[0] || "schema";
  const schema = verb === "schema";
  const rawPath = schema ? "/api/v1/schema/" : args[1] || "";
  const rest = schema ? args.slice(1) : args.slice(2);
  const method = verb === "schema" ? "GET" : verb.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
    throw new UsageError("Usage: glass get|post|put|patch|delete|head|options <path> [--data JSON]");
  }
  if (!rawPath) throw new UsageError("Missing Glass API path.");
  const { options } = parseOptions(rest, ["idempotent", "noAuth", "binary"]);
  let pathName = rawPath;
  if (!pathName.startsWith("/")) pathName = `/${pathName}`;
  const query = asArray(options.query);
  if (query.length) {
    const url = new globalThis.URL(pathName, "http://glass.local");
    for (const item of query) {
      const index = String(item).indexOf("=");
      if (index < 1) throw new UsageError("--query must be key=value.");
      url.searchParams.append(String(item).slice(0, index), String(item).slice(index + 1));
    }
    pathName = `${url.pathname}${url.search}`;
  }
  const { body, bodyType } = await glassRequestBody(options);
  const requestedResponse = options.binary ? "buffer" : String(options.response || "auto");
  const responseType = requestedResponse === "binary" ? "buffer" : requestedResponse;
  if (!["auto", "buffer", "text", "json"].includes(responseType)) {
    throw new UsageError("--response must be auto, json, text, or binary.");
  }
  const headers = glassHeaders(options);
  if (bodyType === "form" && options.contentType) {
    throw new UsageError("Do not set --content-type for multipart forms; the boundary is automatic.");
  }
  if (responseType === "buffer" && !Object.keys(headers).some((name) => name.toLowerCase() === "accept")) {
    headers.Accept = "*/*";
  }
  const result = await api.raw(ctx, method, pathName, body, {
    auth: !options.noAuth,
    idempotent: Boolean(options.idempotent),
    bodyType,
    responseType,
    headers,
  });
  if (options.output) {
    const output = Buffer.isBuffer(result)
      ? atomicWriteBytes(options.output, result)
      : typeof result === "string"
        ? atomicWriteText(options.output, result)
        : atomicWriteText(options.output, `${JSON.stringify(result, null, 2)}\n`);
    if (ctx.config.json || ctx.config.jsonl) printResult(ctx, { output }, () => {});
    else console.log(output);
    return;
  }
  if (Buffer.isBuffer(result)) {
    if (process.stdout.isTTY) throw new UsageError("Binary responses require --output when stdout is a terminal.");
    process.stdout.write(result);
    return;
  }
  printResult(ctx, result, (value) => {
    if (typeof value === "string") console.log(value);
    else printJson(value);
  });
}

async function dispatch(ctx, cmd, args) {
  switch (cmd || "help") {
    case "help":
    case "-h":
    case "--help":
      printHelp();
      return;
    case "version":
    case "--version":
      console.log(VERSION);
      return;
    case "install":
      await cmdInstall(ctx, args);
      return;
    case "config":
      await cmdConfig(ctx, args);
      return;
    case "auth":
      await cmdAuth(ctx, args);
      return;
    case "status":
      await cmdStatus(ctx);
      return;
    case "update":
    case "update-check":
    case "check-update":
      await cmdUpdate(ctx, cmd === "update" ? args : ["check", ...args]);
      return;
    case "me":
      await cmdMe(ctx);
      return;
    case "profile":
      await cmdProfile(ctx, args);
      return;
    case "preferences":
    case "settings":
      await cmdPreferences(ctx, args);
      return;
    case "devices":
      await cmdDevices(ctx, args);
      return;
    case "rooms":
      await cmdRooms(ctx, args);
      return;
    case "messages":
    case "events":
      await cmdMessages(ctx, args);
      return;
    case "history":
      await cmdMessages(ctx, ["history", ...args]);
      return;
    case "recent":
      await cmdMessages(ctx, ["recent", ...args]);
      return;
    case "send":
      requireAuth(ctx);
      await sendMessage(ctx, args);
      return;
    case "send-event":
      await cmdMessages(ctx, ["send-event", ...args]);
      return;
    case "browser":
    case "remote-browser":
    case "remote_browser":
      await cmdRemoteBrowser(ctx, args);
      return;
    case "dm":
      await cmdDm(ctx, args);
      return;
    case "listen":
    case "tail":
      await cmdListen(ctx, args);
      return;
    case "daemon":
      await cmdDaemon(ctx, args);
      return;
    case "inbox":
      await cmdInbox(ctx, args);
      return;
    case "operations":
    case "outbox":
      await cmdOperations(ctx, args);
      return;
    case "drafts":
    case "draft":
      await cmdDrafts(ctx, args);
      return;
    case "held":
    case "held-sends":
      await cmdHeld(ctx, args);
      return;
    case "chat":
      await cmdChat(ctx, args);
      return;
    case "presence":
      await cmdPresence(ctx, args);
      return;
    case "activity":
      await cmdActivity(ctx, args);
      return;
    case "typing":
      await cmdTyping(ctx, args);
      return;
    case "read":
      await cmdRead(ctx, args);
      return;
    case "progress":
      await cmdProgress(ctx, args);
      return;
    case "delta":
      await cmdDelta(ctx, args);
      return;
    case "final":
      await cmdFinal(ctx, args);
      return;
    case "take-back":
    case "takeback":
      await cmdTakeBack(ctx, args);
      return;
    case "delete":
    case "delete-event":
      await cmdDelete(ctx, args);
      return;
    case "search":
      await cmdSearch(ctx, args);
      return;
    case "gif":
    case "gifs":
      await cmdGif(ctx, args);
      return;
    case "send-file":
      await cmdSendFile(ctx, args);
      return;
    case "send-files":
    case "send-album":
      await cmdSendFiles(ctx, args);
      return;
    case "attachments":
    case "attachment":
      await cmdAttachments(ctx, args);
      return;
    case "media":
      await cmdMedia(ctx, args);
      return;
    case "tts":
      await cmdTts(ctx, args);
      return;
    case "stt":
      await cmdStt(ctx, args);
      return;
    case "crons":
    case "cron":
      await cmdCrons(ctx, args);
      return;
    case "sessions":
    case "session":
      await cmdSessions(ctx, args);
      return;
    case "contacts":
    case "contact":
      await cmdContacts(ctx, args);
      return;
    case "teams":
    case "team":
      await cmdTeams(ctx, args);
      return;
    case "invites":
    case "invite":
      await cmdInvites(ctx, args);
      return;
    case "browser-session":
    case "cloud-browser":
      await cmdSiliconBrowser(ctx, args);
      return;
    case "take-back-policy":
    case "takeback-policy":
      await cmdTakeBackPolicy(ctx, args);
      return;
    case "moderation":
    case "safety":
      await cmdModeration(ctx, args);
      return;
    case "announcements":
      await cmdAnnouncements(ctx);
      return;
    case "cost":
    case "costs":
      await cmdCost(ctx, args);
      return;
    case "push":
      await cmdPush(ctx, args);
      return;
    case "challenge":
    case "abuse-challenge":
      await cmdChallenge(ctx, args);
      return;
    case "glass":
    case "api":
      await cmdGlass(ctx, args);
      return;
    default:
      throw new UsageError(`Unknown command '${cmd}'. Run 'pnpm si help'.`);
  }
}

async function main() {
  const parsed = parseGlobalArgs(process.argv.slice(2));
  const config = resolveRuntimeConfig(parsed.flags);
  const [cmd, ...args] = parsed.args;
  await dispatch({ config }, cmd, args);
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`usage: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof ApiError) {
    console.error(`api ${error.status}: ${error.message}`);
    if (error.body) console.error(JSON.stringify(error.body, null, 2));
    process.exitCode = 1;
    return;
  }
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
