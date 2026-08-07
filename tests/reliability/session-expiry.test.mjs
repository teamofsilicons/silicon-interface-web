import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bootDecisionEntersApp,
  sessionBootDecision,
} from "../../src/lib/session-bootstrap.ts";

const authGuardSource = await readFile(
  new URL("../../src/components/auth-guard.tsx", import.meta.url),
  "utf8",
);

test("an unreachable Glass never presents a retained owner with logout", () => {
  // Cookie eviction, privacy races, and captive portals all land here. None of
  // them prove the credential is gone, so the session must stay silent.
  for (const confirmations of [0, 1, 2, 50]) {
    assert.equal(
      sessionBootDecision("anonymous", true, confirmations, false),
      "enter-and-retry",
    );
    assert.equal(
      sessionBootDecision("unavailable", true, confirmations, true),
      "enter-and-retry",
    );
  }
});

test("a reachable Glass answering anonymous stops the silent retry loop", () => {
  // One reachable anonymous answer can still be a stale-token race; a repeat
  // proves the renewable credential is genuinely gone.
  assert.equal(sessionBootDecision("anonymous", true, 1, true), "enter-and-retry");
  assert.equal(
    sessionBootDecision("anonymous", true, 2, true),
    "enter-and-signin-required",
  );
  assert.equal(
    sessionBootDecision("anonymous", true, 9, true),
    "enter-and-signin-required",
  );
});

test("an expired session is never destructive: the owner stays inside the app", () => {
  const decision = sessionBootDecision("anonymous", true, 3, true);
  assert.notEqual(decision, "login");
  assert.equal(bootDecisionEntersApp(decision), true);
  // Only an authoritative backend revocation may end a retained session.
  assert.equal(sessionBootDecision("revoked", true, 0, true), "login");
});

test("anonymous confirmations still decide a browser with no retained owner", () => {
  // This counter was previously unreachable for every browser that had ever
  // signed in, because the retained-owner branch returned before it.
  assert.equal(sessionBootDecision("anonymous", false, 1, true), "confirm-anonymous");
  assert.equal(sessionBootDecision("anonymous", false, 2, true), "login");
  assert.equal(sessionBootDecision("anonymous", false, 2, false), "login");
});

test("restored and unavailable states are unchanged by reachability evidence", () => {
  for (const reachable of [true, false]) {
    assert.equal(sessionBootDecision("restored", true, 0, reachable), "enter");
    assert.equal(sessionBootDecision("restored", false, 5, reachable), "enter");
    assert.equal(sessionBootDecision("unavailable", false, 5, reachable), "retry");
  }
});

test("reachability is probed only for the case it can decide", () => {
  // Probing on every restore would put a network call in front of every boot.
  const probe = authGuardSource.indexOf("probeApiConnectivity()");
  assert.ok(probe > 0);
  const guard = authGuardSource.slice(
    authGuardSource.lastIndexOf("const glassReachable", probe),
    probe,
  );
  assert.match(guard, /state === "anonymous"/);
  assert.match(guard, /hasRetainedOwner/);
});

test("the sign-in prompt keeps the login route reachable", () => {
  // The banner's only action routes here; a retained owner used to be bounced
  // straight back to /chat, leaving no way to sign in again.
  const routeGuard = authGuardSource.indexOf("export function AuthRouteGuard");
  assert.ok(routeGuard > 0);
  const signinBranch = authGuardSource.indexOf(
    'decision === "enter-and-signin-required"',
    routeGuard,
  );
  const redirect = authGuardSource.indexOf('router.replace("/chat")', routeGuard);
  assert.ok(signinBranch > 0 && signinBranch < redirect);
});
