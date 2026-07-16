import assert from "node:assert/strict";
import test from "node:test";

import { classifyConnectivity } from "../../src/lib/connectivity-classifier.ts";

test("an unavailable interface is offline regardless of stale response evidence", () => {
  assert.equal(
    classifyConnectivity({ navigatorOnline: false, responseKind: "ok-json" }),
    "offline",
  );
});

test("only the exact JSON health contract proves HTTPS reachability", () => {
  assert.equal(
    classifyConnectivity({ navigatorOnline: true, responseKind: "ok-json" }),
    "reachable",
  );
  assert.equal(
    classifyConnectivity({ navigatorOnline: true, responseKind: "http-error" }),
    "degraded",
  );
  assert.equal(
    classifyConnectivity({ navigatorOnline: true, transportFailed: true }),
    "degraded",
  );
});

test("redirect and HTML interception are captive rather than generic offline", () => {
  assert.equal(
    classifyConnectivity({ navigatorOnline: true, responseKind: "redirect" }),
    "captive",
  );
  assert.equal(
    classifyConnectivity({ navigatorOnline: true, responseKind: "html" }),
    "captive",
  );
});
