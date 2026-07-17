import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../src/instrumentation-client.ts", import.meta.url), "utf8");

test("PostHog state cannot create parent-domain cookies visible to Glass", () => {
  assert.match(source, /cross_subdomain_cookie:\s*false/);
  assert.match(source, /persistence:\s*["']localStorage["']/);
  assert.match(source, /clearLegacyParentDomainPosthogCookies\(\)/);
  assert.match(source, /Domain=\$\{domain\}/);
  assert.doesNotMatch(source, /persistence:\s*["'](?:cookie|localStorage\+cookie)["']/);
});

test("private chat analytics never starts session replay uploads", () => {
  assert.match(source, /disable_session_recording:\s*true/);
  assert.doesNotMatch(source, /disable_session_recording:\s*false/);
});
