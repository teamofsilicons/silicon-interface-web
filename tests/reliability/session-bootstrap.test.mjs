import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySessionRestoreFailure,
  compatibilityRestoreAllowsEntry,
  isAuthoritativeSessionRevocation,
  sessionBootDecision,
} from "../../src/lib/session-bootstrap.ts";

test("only explicit auth rejection is treated as an ended browser session", () => {
  for (const status of [400, 401]) {
    assert.equal(classifySessionRestoreFailure(status), "anonymous");
  }
  for (const status of [null, 0, 403, 408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classifySessionRestoreFailure(status), "unavailable");
  }
  const revoked = { code: "web_session_revoked" };
  assert.equal(classifySessionRestoreFailure(401, revoked), "revoked");
  assert.equal(isAuthoritativeSessionRevocation(401, revoked), true);
  assert.equal(isAuthoritativeSessionRevocation(401, { code: "token_not_valid" }), false);
});

test("transient restoration failures never redirect a known owner to login", () => {
  assert.equal(sessionBootDecision("unavailable", true, 0), "enter-and-retry");
  assert.equal(sessionBootDecision("unavailable", false, 0), "retry");
  assert.equal(sessionBootDecision("restored", false, 0), "enter");
});

test("anonymous restoration is confirmed before showing login", () => {
  assert.equal(sessionBootDecision("anonymous", true, 1), "enter-and-retry");
  assert.equal(sessionBootDecision("anonymous", false, 1), "confirm-anonymous");
  assert.equal(sessionBootDecision("anonymous", true, 2), "enter-and-retry");
  assert.equal(sessionBootDecision("anonymous", true, 200), "enter-and-retry");
  assert.equal(sessionBootDecision("anonymous", false, 2), "login");
  assert.equal(sessionBootDecision("revoked", true, 0), "login");
});

test("compatibility entry points retain a known offline owner", () => {
  assert.equal(compatibilityRestoreAllowsEntry("restored", false), true);
  assert.equal(compatibilityRestoreAllowsEntry("unavailable", true), true);
  assert.equal(compatibilityRestoreAllowsEntry("anonymous", true), true);
  assert.equal(compatibilityRestoreAllowsEntry("anonymous", false), false);
});
