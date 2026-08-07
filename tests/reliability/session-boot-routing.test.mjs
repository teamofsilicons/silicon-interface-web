import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";
import { canEnterAppFromLanding } from "../../src/lib/session-bootstrap.ts";

const storage = installBrowser(new MemoryStorage());
// Decoding a refresh JWT's `exp` goes through window.atob, exactly as the
// device-claim reader in the auth store does.
globalThis.window.atob = (value) => Buffer.from(value, "base64").toString("binary");
const expiry = await import("../../src/lib/session-expiry.ts");

const authGuardSource = await readFile(
  new URL("../../src/components/auth-guard.tsx", import.meta.url),
  "utf8",
);
const landingSource = await readFile(
  new URL("../../src/app/page.tsx", import.meta.url),
  "utf8",
);

const KEY = "silicon-interface:session-expiry";
const DAY_MS = 24 * 60 * 60 * 1_000;

function reset() {
  storage.clear();
}

test("a renewed session records no credential, only when it was renewed", () => {
  reset();
  expiry.noteSessionRenewed("opaque-cookie-backed-session");
  const record = JSON.parse(storage.getItem(KEY));
  assert.deepEqual(Object.keys(record).sort(), ["expiredAt", "expiresAt", "renewedAt"]);
  assert.equal(typeof record.renewedAt, "number");
  assert.equal(record.expiredAt, null);
  // A non-JWT (the web flow keeps its refresh token in an HttpOnly cookie)
  // yields no exact expiry, and must never be stored verbatim.
  assert.equal(record.expiresAt, null);
  assert.doesNotMatch(storage.getItem(KEY), /opaque-cookie-backed-session/);
  assert.equal(expiry.renewableSessionExpired(), false);
});

test("an exact refresh expiry is read from the token when a flow supplies one", () => {
  reset();
  const exp = Math.floor((Date.now() + DAY_MS) / 1_000);
  const jwt = `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;
  expiry.noteSessionRenewed(jwt);
  assert.equal(JSON.parse(storage.getItem(KEY)).expiresAt, exp * 1_000);
  assert.equal(expiry.renewableSessionExpired(), false);
  // Time passing is enough on its own once the expiry is known exactly.
  assert.equal(expiry.renewableSessionExpired(Date.now() + DAY_MS + 1), true);
});

test("expiry is never inferred from absence of evidence", () => {
  reset();
  // A browser that has never booted, one whose storage was cleared, and one
  // that has only ever been offline all land here. None of them may be treated
  // as signed out — that is what turns a captive portal into a logout.
  assert.equal(expiry.renewableSessionExpired(), false);
  storage.setItem(KEY, "not json at all");
  assert.equal(expiry.renewableSessionExpired(), false);
  storage.setItem(KEY, JSON.stringify({ renewedAt: "whenever", expiredAt: "yes" }));
  assert.equal(expiry.renewableSessionExpired(), false);
});

test("proven expiry survives a reload, and a renewal retires it", () => {
  reset();
  expiry.noteSessionExpired();
  const first = JSON.parse(storage.getItem(KEY)).expiredAt;
  assert.equal(typeof first, "number");
  assert.equal(expiry.renewableSessionExpired(), true);

  // Idempotent: repeated proof keeps the first observation stable.
  expiry.noteSessionExpired();
  assert.equal(JSON.parse(storage.getItem(KEY)).expiredAt, first);

  // Signing in again is the one thing that clears it.
  expiry.noteSessionRenewed(null);
  assert.equal(expiry.renewableSessionExpired(), false);
  expiry.forgetSessionExpiry();
  assert.equal(storage.getItem(KEY), null);
  assert.equal(expiry.renewableSessionExpired(), false);
});

test("the landing page enters the app for anyone not proven signed out", () => {
  // live credential, retained owner, logged out, expired
  assert.equal(canEnterAppFromLanding(true, false, false, false), true);
  assert.equal(canEnterAppFromLanding(false, true, false, false), true);
  // Unknown expiry is not evidence: a returning owner still goes to their chats.
  assert.equal(canEnterAppFromLanding(false, true, false, true), false);
  // Explicit logout outranks everything, including a live in-memory token.
  assert.equal(canEnterAppFromLanding(true, true, true, false), false);
  // A browser with nothing local has nothing to enter with.
  assert.equal(canEnterAppFromLanding(false, false, false, false), false);
});

test("the landing page routes on local state before any network call", () => {
  // The whole point: a returning owner must not watch a marketing page while a
  // refresh round trip decides. The redirect is reached without an await.
  const effect = landingSource.indexOf("React.useEffect");
  const enter = landingSource.indexOf("canEnterAppFromLanding", effect);
  const restore = landingSource.indexOf("await api.restoreWebSession()", effect);
  assert.ok(enter > 0 && restore > enter);
  assert.match(landingSource.slice(effect, enter), /const enterApp = \(\) => \{/);
  // A session already proven expired stays here and asks Glass nothing.
  assert.match(
    landingSource.slice(enter, restore),
    /wasExplicitlyLoggedOut\(\) \|\| renewableSessionExpired\(\)/,
  );
});

test("a boot that proves expiry routes to the landing page", () => {
  const branch = authGuardSource.indexOf('decision === "enter-and-signin-required"');
  assert.ok(branch > 0);
  const body = authGuardSource.slice(branch, branch + 1200);
  assert.match(body, /noteSessionExpired\(\)/);
  // Still loading → route out. Already in use → say it in place instead of
  // yanking a reader out of a room they are part-way through.
  assert.match(body, /if \(!restoredSinceMount\) \{/);
  assert.match(body, /router\.replace\("\/"\)/);
  assert.match(body, /reportSignInRequired\(\)/);
});

test("a known-expired browser reaches the login form without a round trip", () => {
  // The bug this closes: the confirmation counter was per-mount, and the guard
  // unmounts on every decision. /auth/login mounted fresh, counted its FIRST
  // anonymous answer, resolved to enter-and-retry, and redirected to /chat — so
  // the owner it existed to let sign in was bounced away every single time.
  assert.match(authGuardSource, /^let anonymousConfirmations = 0;$/m);
  assert.doesNotMatch(authGuardSource, /let anonymousConfirmations = 0;\s*\n\s*(if|const|\/\/)/);
  const routeGuard = authGuardSource.indexOf("export function AuthRouteGuard");
  assert.ok(routeGuard > 0);
  const guard = authGuardSource.slice(routeGuard, routeGuard + 900);
  // Proof on disk short-circuits the form open, so a full reload cannot lose it.
  assert.match(guard, /wasExplicitlyLoggedOut\(\) \|\| renewableSessionExpired\(\)/);
  assert.doesNotMatch(guard, /let anonymousConfirmations/);
});

test("the guard skips its own boot entirely when expiry is already known", () => {
  const paint = authGuardSource.indexOf("canPaintRetainedSession(");
  const shortCircuit = authGuardSource.lastIndexOf("if (renewableSessionExpired()) {", paint);
  assert.ok(shortCircuit > 0);
  // No paint and no probe: the record alone decides, before boot() is called.
  const bootStart = authGuardSource.indexOf("void boot();");
  assert.ok(shortCircuit < bootStart);
  assert.match(
    authGuardSource.slice(shortCircuit, paint),
    /router\.replace\("\/"\);/,
  );
});
