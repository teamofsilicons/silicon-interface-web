import assert from "node:assert/strict";
import test from "node:test";

import {
  classifySessionRestoreFailure,
  sessionBootDecision,
} from "../../src/lib/session-bootstrap.ts";

test("only explicit auth rejection is treated as an ended browser session", () => {
  for (const status of [400, 401, 403]) {
    assert.equal(classifySessionRestoreFailure(status), "anonymous");
  }
  for (const status of [null, 0, 408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(classifySessionRestoreFailure(status), "unavailable");
  }
});

test("transient restoration failures never redirect a known owner to login", () => {
  assert.equal(sessionBootDecision("unavailable", true, 0), "enter-and-retry");
  assert.equal(sessionBootDecision("unavailable", false, 0), "retry");
  assert.equal(sessionBootDecision("restored", false, 0), "enter");
});

test("anonymous restoration is confirmed before showing login", () => {
  assert.equal(sessionBootDecision("anonymous", true, 1), "confirm-anonymous");
  assert.equal(sessionBootDecision("anonymous", false, 1), "confirm-anonymous");
  assert.equal(sessionBootDecision("anonymous", true, 2), "login");
});
