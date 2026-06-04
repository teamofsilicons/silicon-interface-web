#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_API_BASE = "http://127.0.0.1:8000";
const CONFIG_DIR = path.join(
  process.env.SILICON_INTERFACE_HOME || path.join(os.homedir(), ".silicon-interface"),
);
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const VERSION = "0.1.1";

class UsageError extends Error {}

class ApiError extends Error {
  constructor(status, body, message) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

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

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Best effort: Windows and some filesystems do not support chmod.
  }
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
    } else if (arg === "--json") {
      flags.json = true;
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
    defaultRoom: fileConfig.defaultRoom || "",
    detectedGlassPath: glassConfig.source || "",
    detectedSiliconUsername: glassConfig.siliconUsername || "",
    legacyConfigPath: legacyConfig.source || "",
    json: Boolean(flags.json),
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
  if (typeof content.caption === "string") return content.caption;
  if (typeof content.transcript === "string") return content.transcript;
  if (typeof content.summary === "string") return content.summary;
  if (content.media_id) return `[${event.type} ${content.media_id}]`;
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
  else renderHuman(value);
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
  if (frame.type === "event") return eventLine(frame.event, frame.room_id);
  if (frame.type === "event.delta") return `${frame.room_id} delta ${frame.event_id}: ${frame.delta}`;
  if (frame.type === "event.final") return `${frame.room_id} final ${frame.event_id}`;
  if (frame.type === "event.transcript") return `${frame.room_id} transcript ${frame.event_id}: ${frame.transcript}`;
  if (frame.type === "read_receipt") return `${frame.room_id} read ${frame.event_id}`;
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
  return JSON.stringify(frame);
}

function joinUrl(base, pathName) {
  return `${cleanBase(base)}${pathName.startsWith("/") ? pathName : `/${pathName}`}`;
}

async function request(ctx, method, pathName, body, { auth = true } = {}) {
  const headers = { Accept: "application/json" };
  if (auth) {
    if (ctx.config.accessToken) headers.Authorization = `Bearer ${ctx.config.accessToken}`;
    if (ctx.config.siliconKey) headers["X-Silicon-Key"] = ctx.config.siliconKey;
  }
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(joinUrl(ctx.config.apiBase, pathName), init);
  const contentType = response.headers.get("content-type") || "";
  const parsed = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && "detail" in parsed ? parsed.detail : undefined;
    throw new ApiError(response.status, parsed, detail || `${method} ${pathName} -> ${response.status}`);
  }
  return parsed;
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
  meSilicon: (ctx) => request(ctx, "GET", "/api/v1/silicons/me"),
  rooms: (ctx) => request(ctx, "GET", "/api/v1/rooms/"),
  room: (ctx, roomId) => request(ctx, "GET", `/api/v1/rooms/${encodeURIComponent(roomId)}/`),
  members: (ctx, roomId) => request(ctx, "GET", `/api/v1/rooms/${encodeURIComponent(roomId)}/members`),
  events: (ctx, roomId, { before, limit = 50 } = {}) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (before) qs.set("before", before);
    return request(ctx, "GET", `/api/v1/rooms/${encodeURIComponent(roomId)}/events?${qs}`);
  },
  directRoom: (ctx, kind, targetId) =>
    request(ctx, "POST", "/api/v1/rooms/direct", { target_kind: kind, target_id: targetId }),
  sendEvent: (ctx, roomId, payload) =>
    request(ctx, "POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/events`, payload),
  read: (ctx, roomId, eventId) =>
    request(ctx, "POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/read`, { event_id: eventId }),
  activity: (ctx, roomId, state, active) =>
    request(ctx, "POST", `/api/v1/rooms/${encodeURIComponent(roomId)}/activity`, { state, active }),
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
};

async function resolveTarget(ctx, kind, value) {
  const endpoint = kind === "carbon" ? api.carbonByHandle : api.siliconByHandle;
  const resolved = await attempt(() => endpoint(ctx, value));
  if (!resolved.ok) return { kind, id: value, handle: value, raw: null };
  const raw = resolved.value;
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
  pnpm si <command> [args] [--json]
  pnpm silicon-interface <command> [args]

Global options:
  --api <url>             Backend API base. Default: ${DEFAULT_API_BASE}
  --ws <url>              WebSocket base. Default: derived from API base.
  --key <key>             Silicon API key for this invocation.
  --access-token <token>  Carbon JWT for dev/admin testing.
  --json                  Machine-readable output.

Setup:
  install [target]        Install local wrappers into a silicon folder.
  auth status             Check the configured identity.
  auth import-glass [dir] Import key/server from a Glass-managed .glass.json.
  auth set-key [key]      Store an X-Silicon-Key manually in ${CONFIG_PATH}.
                          Usually unnecessary inside a Glass-pulled silicon.
  config show             Show persisted config and detected Glass config.
  config set <key> <val>  Keys: apiBase, wsBase, siliconKey, accessToken, defaultRoom.

Status:
  status                  Health, readiness, version, silicon identity, room count.
  me                      Show /silicons/me.

Rooms and messages:
  rooms list              List rooms.
  rooms show <room>       Show a room, its members, and recent events.
  rooms direct <kind> <handle-or-id>
  messages list <room> [--limit 50] [--before event_id]
  messages send <room> <text...> [--reply-to event_id]
  send <room> <text...>   Alias for messages send.
  dm <carbon|silicon> <handle-or-id> [text...]
  browser <room> <url> [--ttl 60]
  remote-browser <room> <url> [--ttl-minutes 60]
  chat <room>             Interactive stdin chat for a room.
  listen [room|all]       Stream live WebSocket frames.

Activity and event controls:
  activity <room> <typing|uploading|recording> <on|off>
  read <room> <event_id>
  progress <room> <state> [note...] [--group id] [--pct n]
  delta <event_id> <text...> [--seq n]
  final <event_id>
  take-back <event_id> [--reason text] [--force]
  take-back requests [--status pending]
  take-back complete <request_id> <replacement text...>
  delete <event_id>
  search <query...> [--room room_id] [--interval 20]

Media and jobs:
  send-file <room> <path> [caption...]
  media show <media_id>
  tts <text...> [--room room_id] [--voice name] [--scene x] [--style x]
  stt <media_id> [--language code]

Crons:
  crons list [--mine] [--for id] [--setup-by silicon_id]
  crons show <cron_id>
  crons create --trigger "*/5 * * * *" --target carbon:alice --task "check in"
  crons patch <cron_id> [--trigger expr] [--task text] [--active true|false]
  crons delete <cron_id>

Other:
  sessions list | new <room> [summary...] | end <session_id> [summary...]
  contacts list | save <kind> <id> [--name n] [--note n] | update <id> ... | delete <id>
`);
}

async function cmdConfig(ctx, args) {
  const [sub, key, ...rest] = args;
  const fileConfig = readConfig();
  const allowed = new Set(["apiBase", "wsBase", "siliconKey", "accessToken", "defaultRoom"]);
  if (!sub || sub === "show" || sub === "get") {
    const shown = {
      path: CONFIG_PATH,
      ...fileConfig,
      siliconKey: fileConfig.siliconKey ? `${fileConfig.siliconKey.slice(0, 8)}...` : "",
      accessToken: fileConfig.accessToken ? `${fileConfig.accessToken.slice(0, 8)}...` : "",
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
  const { positionals } = parseOptions(args);
  const installed = installInto(positionals[0] || ".");
  printResult(ctx, installed, (value) => {
    console.log(`Installed Silicon Interface CLI in ${value.target}`);
    console.log(`package: ${value.package}`);
    console.log(`bin: ${value.binDir}`);
    console.log(`run: ${path.join(value.binDir, "si")} help`);
    if (!value.glassDetected) {
      console.log("note: no .glass.json detected yet; commands will need env auth or later Glass setup.");
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

async function cmdAuth(ctx, args) {
  const [sub, ...rest] = args;
  const fileConfig = readConfig();
  if (sub === "set-key") {
    let key = rest.join(" ").trim();
    if (!key && !process.stdin.isTTY) key = fs.readFileSync(0, "utf8").trim();
    if (!key) key = (await readLine("Silicon key: ")).trim();
    if (!key) throw new UsageError("Missing silicon key.");
    fileConfig.siliconKey = key;
    writeConfig(fileConfig);
    console.log("Silicon key saved.");
    return;
  }
  if (sub === "import-glass") {
    const glass = loadGlassConfig(rest[0] || process.cwd());
    if (!glass.siliconKey) {
      throw new UsageError("No Glass api_key found. Run this inside a Glass-pulled silicon folder or pass a .glass.json path.");
    }
    fileConfig.siliconKey = glass.siliconKey;
    if (glass.apiBase) fileConfig.apiBase = cleanBase(glass.apiBase);
    if (glass.wsBase) fileConfig.wsBase = cleanBase(glass.wsBase);
    writeConfig(fileConfig);
    console.log(`Imported Glass auth from ${glass.source}.`);
    return;
  }
  if (sub === "clear") {
    delete fileConfig.siliconKey;
    delete fileConfig.accessToken;
    writeConfig(fileConfig);
    console.log("Auth cleared.");
    return;
  }
  if (!sub || sub === "status") {
    requireAuth(ctx);
    const me = await api.meSilicon(ctx);
    printResult(ctx, me, (value) => {
      console.log(`${value.name} (${value.silicon_id})`);
      console.log(`active: ${value.is_active}`);
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
  const me = ctx.config.siliconKey || ctx.config.accessToken ? await attempt(() => api.meSilicon(ctx)) : null;
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
    if (me) console.log(`silicon: ${me.ok ? `${me.value.name} (${me.value.silicon_id})` : me.error.message}`);
    if (rooms) console.log(`rooms: ${rooms.ok ? rooms.value.length : rooms.error.message}`);
  });
}

async function cmdMe(ctx) {
  requireAuth(ctx);
  const me = await api.meSilicon(ctx);
  printResult(ctx, me, (value) => printJson(value));
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
      api.events(ctx, roomId, { limit: Number(options.limit || 20) }),
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

async function cmdMessages(ctx, args) {
  requireAuth(ctx);
  const [sub = "list", ...rest] = args;
  if (sub === "list" || sub === "ls") {
    const { options, positionals } = parseOptions(rest);
    const roomId = roomArg(ctx, positionals[0]);
    const events = await api.events(ctx, roomId, {
      limit: Number(options.limit || 50),
      before: options.before,
    });
    printResult(ctx, events, (rows) => {
      for (const event of rows) console.log(eventLine(event));
    });
    return;
  }
  if (sub === "send") {
    await sendMessage(ctx, rest);
    return;
  }
  throw new UsageError(`Unknown messages command '${sub}'.`);
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
  const event = await api.sendEvent(ctx, roomId, payload);
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
  const event = await api.sendEvent(ctx, roomId, {
    type: "m.remote_browser",
    content,
  });
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
  const event = await api.sendEvent(ctx, room.room_id, { type: "m.text", content: { body } });
  printResult(ctx, { room, event }, (value) => {
    console.log(`room: ${value.room.room_id}`);
    console.log(eventLine(value.event));
  });
}

async function openSocket(ctx, roomIds, onFrame) {
  requireAuth(ctx);
  const SocketCtor = globalThis.WebSocket;
  if (typeof SocketCtor !== "function") {
    throw new UsageError("This Node runtime has no global WebSocket. Use Node 22+ or run REST commands.");
  }
  const qs = new URLSearchParams();
  if (ctx.config.siliconKey) qs.set("silicon_key", ctx.config.siliconKey);
  else qs.set("token", ctx.config.accessToken);
  const socket = new SocketCtor(`${ctx.config.wsBase}/ws/v1/?${qs}`);
  await new Promise((resolve, reject) => {
    const fail = (event) => reject(new Error(event?.message || "WebSocket failed to open."));
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", fail, { once: true });
  });
  for (const roomId of roomIds) {
    socket.send(JSON.stringify({ type: "subscribe", room_id: roomId }));
  }
  const ping = setInterval(() => {
    if (socket.readyState === SocketCtor.OPEN) socket.send(JSON.stringify({ type: "ping" }));
  }, 25_000);
  socket.addEventListener("message", (event) => {
    try {
      onFrame(JSON.parse(event.data));
    } catch {
      // Ignore malformed frames.
    }
  });
  socket.addEventListener("close", () => clearInterval(ping), { once: true });
  return socket;
}

async function roomIdsForListen(ctx, target) {
  if (!target || target === "all") {
    const rooms = await api.rooms(ctx);
    return rooms.map((room) => room.room_id);
  }
  return [roomArg(ctx, target)];
}

async function cmdListen(ctx, args) {
  const { positionals } = parseOptions(args);
  const roomIds = await roomIdsForListen(ctx, positionals[0]);
  const socket = await openSocket(ctx, roomIds, (frame) => {
    if (ctx.config.json) printJson(frame, true);
    else console.log(frameLine(frame));
  });
  console.error(`listening to ${roomIds.length} room(s). Ctrl+C to stop.`);
  await new Promise((resolve) => {
    process.once("SIGINT", () => {
      socket.close();
      resolve();
    });
    socket.addEventListener("close", resolve, { once: true });
  });
}

async function cmdChat(ctx, args) {
  const { options, positionals } = parseOptions(args, ["noHistory"]);
  const roomId = roomArg(ctx, positionals[0]);
  if (!options.noHistory) {
    const events = await api.events(ctx, roomId, { limit: Number(options.limit || 25) });
    for (const event of events) console.log(eventLine(event));
    if (events.length) console.log("");
  }
  const socket = await openSocket(ctx, [roomId], (frame) => {
    if (frame.type === "event" && frame.room_id === roomId) console.log(eventLine(frame.event));
    else if (frame.room_id === roomId) console.log(frameLine(frame));
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();
  for await (const line of rl) {
    const body = line.trim();
    if (body === "/quit" || body === "/exit") break;
    if (body) await api.sendEvent(ctx, roomId, { type: "m.text", content: { body } });
    rl.prompt();
  }
  socket.close();
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
  const { options, positionals } = parseOptions(args);
  const q = positionals.join(" ").trim();
  if (!q) throw new UsageError("Usage: search <query...>");
  const result = await api.search(ctx, {
    q,
    room: options.room,
    sender_kind: options.senderKind,
    since: options.since,
    until: options.until,
    block: options.block,
    interval: options.interval,
  });
  printResult(ctx, result, (data) => {
    for (const event of data.results || []) console.log(eventLine(event));
    console.log(`block ${data.block}, total ${data.total}, has_more ${data.has_more}`);
  });
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
  const FormDataCtor = globalThis.FormData;
  const BlobCtor = globalThis.Blob;
  if (typeof FormDataCtor !== "function" || typeof BlobCtor !== "function") {
    throw new UsageError("This Node runtime cannot upload files. Use Node 22+ for FormData/Blob.");
  }
  const form = new FormDataCtor();
  for (const [key, value] of Object.entries(upload.fields || {})) form.append(key, value);
  const bytes = fs.readFileSync(filePath);
  form.append("file", new BlobCtor([bytes], { type: mime }), path.basename(filePath));
  const response = await fetch(upload.url, { method: upload.method || "POST", body: form });
  if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
}

async function cmdSendFile(ctx, args) {
  requireAuth(ctx);
  const [roomToken, filePath, ...captionParts] = args;
  if (!filePath) throw new UsageError("Usage: send-file <room> <path> [caption...]");
  const resolvedPath = path.resolve(filePath);
  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) throw new UsageError(`Not a file: ${resolvedPath}`);
  const mime = mimeFromPath(resolvedPath);
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "voice" : "file";
  const presigned = await api.presignUpload(ctx, {
    mime,
    size: stat.size,
    kind,
    filename: path.basename(resolvedPath),
    room_id: roomArg(ctx, roomToken),
  });
  await uploadPresigned(presigned.upload, resolvedPath, mime);
  if (!presigned.upload.dev_mode) await api.mediaComplete(ctx, presigned.media.media_id);
  const eventType = mime.startsWith("image/") ? "m.image" : kind === "voice" ? "m.voice" : "m.file";
  const caption = captionParts.join(" ").trim() || path.basename(resolvedPath);
  const event = await api.sendEvent(ctx, roomArg(ctx, roomToken), {
    type: eventType,
    content: { media_id: presigned.media.media_id, mime, caption },
  });
  printResult(ctx, { media: presigned.media, event }, (value) => {
    console.log(`media: ${value.media.media_id}`);
    console.log(eventLine(value.event));
  });
}

async function cmdMedia(ctx, args) {
  requireAuth(ctx);
  const [sub, mediaId] = args;
  if (sub !== "show" || !mediaId) throw new UsageError("Usage: media show <media_id>");
  const result = await api.mediaDetail(ctx, mediaId);
  printResult(ctx, result, (data) => printJson(data));
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
    case "me":
      await cmdMe(ctx);
      return;
    case "rooms":
      await cmdRooms(ctx, args);
      return;
    case "messages":
    case "events":
      await cmdMessages(ctx, args);
      return;
    case "send":
      requireAuth(ctx);
      await sendMessage(ctx, args);
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
    case "chat":
      await cmdChat(ctx, args);
      return;
    case "activity":
      await cmdActivity(ctx, args);
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
    case "send-file":
      await cmdSendFile(ctx, args);
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
