// Shared server module for the same-origin HTML preview proxy (Dope #116).
//
// One source of truth for:
//   • the sealed-ticket crypto        — seal()/open() over AES-256-GCM (node:crypto)
//   • the upstream host allow-list     — parseAllowedHosts()/isHostAllowed()
//   • the Upstash single-use store     — kvSetNx()/kvGetDel() over the REST API
//   • env config + the strict headers  — apiBase()/maxBytes()/ttlSeconds()/securityHeaders()
//
// It is imported by BOTH route handlers AND the standalone self-test
// (`scripts/html-preview-ticket.selftest.mjs`) — the self-test runs under plain
// `node` (Node >= 22.18 strips the TS types natively), which is why every
// export here uses only erasable TS syntax and node built-ins / web globals.
//
// SECURITY MODEL — the whole thing is FAIL CLOSED:
//   • missing HTML_PREVIEW_TICKET_SECRET → seal()/ticketKey() throw (mint 503, consume 403)
//   • missing/failing Upstash store      → kv* return null (mint 503, consume 410/503)
//   • the AAD binds every ticket to its media id, so a ticket minted for media A
//     can never be opened at the route for media B.
//
// SERVER-ONLY: this module is imported exclusively by the two server route
// handlers (and the standalone node self-test). It carries no "use client"
// directive and is never imported by any client component, so it never enters
// the browser bundle. (The literal `server-only` package is intentionally NOT
// imported — Next aliases it at build time and it is not resolvable under plain
// `node`, which would break the self-test's requirement to import this file.)
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HtmlTicketPayload {
  /** Schema version. */
  v: 1;
  /** Single-use id — also the Upstash marker key suffix. */
  jti: string;
  /** Media id this ticket is scoped to (mirrors the AAD). */
  media_id: string;
  /** Absolute expiry, unix seconds. */
  exp: number;
  /** Hostname of `url` — cross-checked at consume time. */
  host: string;
  /** The presigned upstream URL the proxy fetches server-side. */
  url: string;
  /** Upstream mime (always text/html for a minted ticket). */
  mime: string;
  /** Known size in bytes, when Glass reports it. */
  size?: number;
}

// ---------------------------------------------------------------------------
// Sealed-ticket crypto (AES-256-GCM)
// ---------------------------------------------------------------------------

const IV_LEN = 12; // 96-bit GCM nonce
const TAG_LEN = 16; // 128-bit GCM auth tag

/**
 * Derive the 32-byte AES key from the raw secret via SHA-256, exactly as the
 * spec dictates. Throws (FAIL CLOSED) when the secret is missing/empty so a
 * misconfigured deploy can never mint under a predictable/empty key.
 */
export function ticketKey(secret?: string): Buffer {
  const s = secret ?? process.env.HTML_PREVIEW_TICKET_SECRET;
  if (!s) throw new Error("HTML_PREVIEW_TICKET_SECRET is not set");
  return createHash("sha256").update(String(s)).digest();
}

/** The AAD string that binds a ticket to a media id. */
export function ticketAad(mediaId: string): string {
  return `html-preview:${mediaId}`;
}

/**
 * Seal a payload into a base64url token: base64url(iv ‖ tag ‖ ciphertext).
 * `aad` binds the ciphertext (GCM AAD). `key` defaults to the env-derived key
 * so the self-test can pass an explicit key instead of touching env.
 */
export function seal(payload: HtmlTicketPayload, aad: string, key?: Buffer): string {
  const k = key ?? ticketKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64url");
}

/**
 * Open + verify a sealed token. Throws on ANY tamper (bad key, flipped byte,
 * truncation) or AAD mismatch (a token sealed for a different media id). Does
 * NOT check expiry — callers compare `exp` to now so the route can distinguish
 * expiry (410) from tamper (403).
 */
export function open(token: string, aad: string, key?: Buffer): HtmlTicketPayload {
  const k = key ?? ticketKey();
  const raw = Buffer.from(String(token), "base64url");
  if (raw.length < IV_LEN + TAG_LEN + 1) throw new Error("ticket malformed");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const payload = JSON.parse(plaintext.toString("utf8")) as HtmlTicketPayload;
  if (payload.v !== 1) throw new Error("unsupported ticket version");
  return payload;
}

/** Fresh single-use id. */
export function newJti(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// Env config
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB
const DEFAULT_TTL = 90;
const MIN_TTL = 60;
const MAX_TTL = 120;

/** Glass API base, mirroring src/lib/env.ts (server reads process.env). */
export function apiBase(): string {
  const isProd = process.env.NODE_ENV === "production";
  const fallback = isProd ? "https://glass.teamofsilicons.com" : "http://127.0.0.1:8000";
  return (process.env.NEXT_PUBLIC_API_BASE ?? fallback).replace(/\/$/, "");
}

/** Parse the comma-separated exact-match host allow-list env into a set. */
export function parseAllowedHosts(raw?: string): string[] {
  return (raw ?? process.env.HTML_PREVIEW_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** Exact-hostname membership test against the allow-list (no suffix matching). */
export function isHostAllowed(host: string, raw?: string): boolean {
  return parseAllowedHosts(raw).includes(host.toLowerCase());
}

export function maxBytes(): number {
  const n = Number(process.env.HTML_PREVIEW_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

export function ttlSeconds(): number {
  const n = Number(process.env.HTML_PREVIEW_TTL_SECONDS);
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TTL;
  return Math.min(MAX_TTL, Math.max(MIN_TTL, v)); // clamp(v, 60, 120)
}

// ---------------------------------------------------------------------------
// Upstash single-use store (REST API over plain fetch, no SDK)
// ---------------------------------------------------------------------------

function upstashConfig(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

/** True only when BOTH Upstash env vars are present. */
export function storeConfigured(): boolean {
  return upstashConfig() !== null;
}

/** Namespaced marker key for a ticket's single-use id. */
export function jtiKey(jti: string): string {
  return `htmlpreview:jti:${jti}`;
}

/**
 * Run one Redis command via the Upstash REST endpoint. Any missing config,
 * network error, non-2xx, or `{ error }` body resolves to `null` — callers
 * fail closed and NEVER treat an error as success.
 */
async function upstashCommand(args: (string | number)[]): Promise<{ result: unknown } | null> {
  const cfg = upstashConfig();
  if (!cfg) return null;
  try {
    const resp = await fetch(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      cache: "no-store",
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { result?: unknown; error?: string };
    if (data && typeof data === "object" && "error" in data && data.error) return null;
    return { result: data.result };
  } catch {
    return null;
  }
}

/**
 * `SET key 1 NX EX ttl` — atomically claim a fresh single-use marker. Returns
 * `true` only when newly written (Upstash → "OK"); `false` when NX prevented it
 * (already exists) or on ANY store error (fail closed).
 */
export async function kvSetNx(key: string, ttl: number): Promise<boolean> {
  const r = await upstashCommand(["SET", key, "1", "NX", "EX", ttl]);
  return !!r && r.result === "OK";
}

/**
 * `GETDEL key` — atomically read-and-delete the marker. Exactly one caller can
 * observe the value; every subsequent call sees null. Returns the value string
 * on the single valid use, or `null` on replay/expiry/store error (fail closed).
 */
export async function kvGetDel(key: string): Promise<string | null> {
  const r = await upstashCommand(["GETDEL", key]);
  if (!r) return null;
  const v = r.result;
  return v === null || v === undefined ? null : String(v);
}

// ---------------------------------------------------------------------------
// Strict security headers (applied to EVERY proxy response, success AND error)
// ---------------------------------------------------------------------------

const CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; " +
  "base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'; " +
  "frame-ancestors 'self'; sandbox";

/** The exact header set every proxy response must carry. */
export function securityHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "SAMEORIGIN",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
  };
}

/**
 * A minimal friendly HTML error page carrying the full security header set. The
 * message is static text only — it NEVER echoes the ticket, url, or query.
 */
export function htmlError(status: number, message: string): Response {
  const safe = message.replace(/[<>&"']/g, "");
  const body =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Preview unavailable</title></head>` +
    `<body style="font:14px system-ui,sans-serif;color:#444;padding:24px">` +
    `<p>${safe}</p></body></html>`;
  return new Response(body, { status, headers: securityHeaders() });
}
