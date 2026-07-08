// Standalone self-test for the sealed HTML-preview ticket crypto (Dope #116).
//
// Runs under plain `node` (no test framework, no build step) — Node >= 22.18
// strips the TS types from the imported module natively:
//
//     node scripts/html-preview-ticket.selftest.mjs
//
// Exercises the crypto invariants the same-origin proxy relies on:
//   • seal/open round-trips a valid ticket
//   • a tampered token fails to open
//   • a token sealed for media A fails to open at media B (AAD binding)
//   • the expiry field is honoured (route-level 410 decision)
//   • the derived key is exactly 32 bytes (AES-256) and secret-dependent
//   • parseAllowedHosts is exact-match, lower-cased, trimmed
//   • a missing secret fails closed (ticketKey throws)
//
// Exits 0 and prints "ALL PASS" only if every assertion holds; otherwise prints
// the failures and exits 1.

// The module reads HTML_PREVIEW_TICKET_SECRET lazily (inside ticketKey), so the
// self-test sets it inline BEFORE calling any function that needs it.
process.env.HTML_PREVIEW_TICKET_SECRET = "self-test-secret-please-ignore";

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(resolve(here, "../src/lib/html-preview-ticket.ts"));
const {
  seal,
  open,
  ticketKey,
  ticketAad,
  newJti,
  parseAllowedHosts,
  isHostAllowed,
  isAllowedPreviewUrl,
  // Preview/dev-only fallbacks (Dope #116 Vercel-preview patch)
  isPreviewEnv,
  resolveTicketKey,
  previewUrlAccepted,
  consumeStoreAvailable,
  kvSetNx,
  kvGetDel,
  jtiKey,
} = mod;

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}`);
  }
}
function threw(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const now = Math.floor(Date.now() / 1000);
function payloadFor(mediaId, exp) {
  return {
    v: 1,
    jti: newJti(),
    media_id: mediaId,
    exp,
    host: "assets.example.com",
    url: "https://assets.example.com/x.html?sig=abc",
    mime: "text/html",
    size: 1234,
  };
}

console.log("html-preview-ticket self-test\n");

// 1) valid seal/open round-trip
{
  const p = payloadFor("media-A", now + 90);
  const tok = seal(p, ticketAad("media-A"));
  const out = open(tok, ticketAad("media-A"));
  check(
    "valid ticket seals + opens (round-trip)",
    out.media_id === "media-A" &&
      out.jti === p.jti &&
      out.exp === p.exp &&
      out.url === p.url &&
      out.host === p.host &&
      out.v === 1,
  );
}

// 2) tampered token fails
{
  const tok = seal(payloadFor("media-A", now + 90), ticketAad("media-A"));
  // Flip a byte in the ciphertext region (base64url → mutate a middle char).
  const chars = tok.split("");
  const i = Math.floor(chars.length / 2);
  chars[i] = chars[i] === "A" ? "B" : "A";
  const bad = chars.join("");
  check("tampered token fails to open", threw(() => open(bad, ticketAad("media-A"))));
}

// 3) truncated token fails
{
  const tok = seal(payloadFor("media-A", now + 90), ticketAad("media-A"));
  const bad = tok.slice(0, tok.length - 4);
  check("truncated token fails to open", threw(() => open(bad, ticketAad("media-A"))));
}

// 4) wrong media id fails (AAD binding)
{
  const tok = seal(payloadFor("media-A", now + 90), ticketAad("media-A"));
  check(
    "wrong media_id (AAD mismatch) fails to open",
    threw(() => open(tok, ticketAad("media-B"))),
  );
}

// 5) expired ticket — opens (crypto valid) but exp is in the past, i.e. the
//    route's 410 branch fires. A fresh ticket's exp is in the future.
{
  const expired = open(
    seal(payloadFor("media-A", now - 5), ticketAad("media-A")),
    ticketAad("media-A"),
  );
  const fresh = open(
    seal(payloadFor("media-A", now + 90), ticketAad("media-A")),
    ticketAad("media-A"),
  );
  check(
    "expired ticket is detected via exp (past exp <= now, fresh exp > now)",
    expired.exp <= now && fresh.exp > now,
  );
}

// 6) wrong key fails (secret binds the ciphertext)
{
  const tok = seal(payloadFor("media-A", now + 90), ticketAad("media-A"), ticketKey("secret-one"));
  check(
    "token sealed under a different secret fails to open",
    threw(() => open(tok, ticketAad("media-A"), ticketKey("secret-two"))),
  );
}

// 7) derived key is 32 bytes (AES-256) and secret-dependent
{
  const k1 = ticketKey("aaa");
  const k2 = ticketKey("aaa");
  const k3 = ticketKey("bbb");
  check(
    "derived key is 32 bytes, deterministic per secret, differs across secrets",
    k1.length === 32 && k1.equals(k2) && !k1.equals(k3),
  );
}

// 8) missing secret fails closed
{
  const saved = process.env.HTML_PREVIEW_TICKET_SECRET;
  delete process.env.HTML_PREVIEW_TICKET_SECRET;
  check("missing secret → ticketKey() throws (fail closed)", threw(() => ticketKey()));
  process.env.HTML_PREVIEW_TICKET_SECRET = saved;
}

// 9) host allow-list is exact-match, trimmed, lower-cased
{
  const hosts = parseAllowedHosts(" Assets.Example.com , cdn.example.com ");
  check(
    "parseAllowedHosts trims + lower-cases",
    hosts.length === 2 && hosts[0] === "assets.example.com" && hosts[1] === "cdn.example.com",
  );
  check(
    "isHostAllowed is exact-match (no suffix wildcard)",
    isHostAllowed("assets.example.com", "assets.example.com") &&
      !isHostAllowed("evil-assets.example.com", "assets.example.com") &&
      !isHostAllowed("assets.example.com.evil.com", "assets.example.com"),
  );
}

// 11) preview URL origin must be HTTPS default port + exact host match
{
  const allowed = "assets.example.com";
  check(
    "allowed preview URL accepts https default port",
    isAllowedPreviewUrl(new URL("https://assets.example.com/file.html"), allowed),
  );
  check(
    "allowed preview URL rejects http scheme",
    !isAllowedPreviewUrl(new URL("http://assets.example.com/file.html"), allowed),
  );
  check(
    "allowed preview URL rejects non-default port",
    !isAllowedPreviewUrl(new URL("https://assets.example.com:444/file.html"), allowed),
  );
}

// ---------------------------------------------------------------------------
// Preview/dev-only fallbacks (Vercel-preview patch). Production stays fail-closed.
// ---------------------------------------------------------------------------

// 12) preview in-memory single-use store: SET NX claims once, GETDEL consumes once
{
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.NODE_ENV = "development"; // isPreviewEnv() → true
  const key = jtiKey(newJti());
  const first = await kvSetNx(key, 90);
  const second = await kvSetNx(key, 90);
  const get1 = await kvGetDel(key);
  const get2 = await kvGetDel(key);
  check(
    "preview in-memory store: SET NX claims once, GETDEL consumes once (single-use)",
    first === true && second === false && get1 === "1" && get2 === null,
  );
  check(
    "consumeStoreAvailable() is true in preview without Upstash",
    consumeStoreAvailable() === true,
  );
}

// 13) production without Upstash fails closed — NO in-memory fallback
{
  const savedVercel = process.env.VERCEL_ENV;
  process.env.NODE_ENV = "production";
  delete process.env.VERCEL_ENV; // isPreviewEnv() → false
  const setProd = await kvSetNx(jtiKey(newJti()), 90);
  check(
    "production without Upstash: kvSetNx fails closed (false) + store unavailable",
    setProd === false && consumeStoreAvailable() === false,
  );
  if (savedVercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = savedVercel;
  process.env.NODE_ENV = "development";
}

// 14) resolveTicketKey: env secret → key; preview fallback when unset; prod throws
{
  process.env.HTML_PREVIEW_TICKET_SECRET = "real-secret";
  const withEnv = resolveTicketKey();
  delete process.env.HTML_PREVIEW_TICKET_SECRET;
  process.env.NODE_ENV = "development"; // preview → fallback key, no throw
  const previewKey = resolveTicketKey();
  process.env.NODE_ENV = "production";
  delete process.env.VERCEL_ENV; // not preview → throws (fail closed)
  const prodThrows = threw(() => resolveTicketKey());
  check(
    "resolveTicketKey: env→32B key, preview→32B fallback key, production→throws",
    withEnv.length === 32 && previewKey.length === 32 && prodThrows === true,
  );
  process.env.NODE_ENV = "development";
  process.env.HTML_PREVIEW_TICKET_SECRET = "self-test-secret-please-ignore";
}

// 15) previewUrlAccepted: strict in prod; in preview with an empty allow-list,
//     any https default-port host is accepted (http / non-default port still rejected)
{
  delete process.env.HTML_PREVIEW_ALLOWED_HOSTS; // empty allow-list
  process.env.NODE_ENV = "development"; // preview
  const previewAny = previewUrlAccepted(new URL("https://whatever.s3.amazonaws.com/a/b?sig=x"));
  const previewHttp = previewUrlAccepted(new URL("http://whatever.s3.amazonaws.com/a"));
  const previewPort = previewUrlAccepted(new URL("https://whatever.s3.amazonaws.com:8443/a"));
  process.env.NODE_ENV = "production";
  delete process.env.VERCEL_ENV; // not preview
  const prodAny = previewUrlAccepted(new URL("https://whatever.s3.amazonaws.com/a"));
  check(
    "previewUrlAccepted: preview+empty-list allows https:443 any-host, rejects http/non-default port; production rejects",
    previewAny === true && previewHttp === false && previewPort === false && prodAny === false,
  );
  process.env.NODE_ENV = "development";
}

// 16) gate precedence: the Vercel prod marker WINS over a stray NODE_ENV
{
  const savedVercel = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = "production";
  process.env.NODE_ENV = "development";
  const prodMarkerWins = isPreviewEnv() === false; // prod marker beats NODE_ENV
  process.env.VERCEL_ENV = "preview";
  process.env.NODE_ENV = "production";
  const previewMarkerOn = isPreviewEnv() === true;
  delete process.env.VERCEL_ENV;
  process.env.NODE_ENV = "production";
  const offVercelProd = isPreviewEnv() === false;
  process.env.NODE_ENV = "development";
  const offVercelDev = isPreviewEnv() === true;
  check(
    "isPreviewEnv: VERCEL_ENV marker wins (prod=false even if NODE_ENV=dev), preview=true; off-Vercel uses NODE_ENV",
    prodMarkerWins && previewMarkerOn && offVercelProd && offVercelDev,
  );
  if (savedVercel === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = savedVercel;
  process.env.NODE_ENV = "development";
}

// 17) preview fallback key is process-local random (stable in-process, 32B) and
//     the OLD committed-constant secret can no longer open a preview ticket
{
  delete process.env.HTML_PREVIEW_TICKET_SECRET;
  delete process.env.VERCEL_ENV;
  process.env.NODE_ENV = "development"; // preview
  const k1 = resolveTicketKey();
  const k2 = resolveTicketKey();
  const tok = seal(payloadFor("media-A", now + 90), ticketAad("media-A"), resolveTicketKey());
  const oldConstantCannotOpen = threw(() =>
    open(
      tok,
      ticketAad("media-A"),
      ticketKey("html-preview::vercel-preview-fallback::not-for-production-use"),
    ),
  );
  check(
    "preview fallback key is process-local random (stable in-process, 32B) and unforgeable by the old committed constant",
    k1.length === 32 && k1.equals(k2) && oldConstantCannotOpen === true,
  );
  process.env.HTML_PREVIEW_TICKET_SECRET = "self-test-secret-please-ignore";
  process.env.NODE_ENV = "development";
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("SELF-TEST FAILED");
  process.exit(1);
}
console.log("ALL PASS");
