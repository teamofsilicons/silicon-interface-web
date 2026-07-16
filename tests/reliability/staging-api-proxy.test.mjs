import assert from "node:assert/strict";
import test from "node:test";

import {
  configuration,
  downstreamHeaders,
  glassCookieHeader,
  upstreamHeaders,
} from "../../scripts/staging-api-proxy.mjs";

test("configuration accepts case-insensitive DNS and pins the loopback UI origin", () => {
  const config = configuration({
    SILICON_STAGING_PROXY_UPSTREAM_HOST: "Glass--LoadB.example.COM",
  });
  assert.equal(config.upstreamHost, "Glass--LoadB.example.COM");
  assert.equal(config.localOrigin, "http://127.0.0.1:3001");

  assert.throws(
    () => configuration({
      SILICON_STAGING_PROXY_UPSTREAM_HOST: "upstream.example.com",
      SILICON_STAGING_PROXY_UI_ORIGIN: "https://attacker.example",
    }),
    /invalid staging proxy configuration/,
  );
});

test("local UI cookies cannot reach Glass or trigger the WAF SSRF cookie rule", () => {
  const cookie = glassCookieHeader(
    'ph_test={"current_url":"http://127.0.0.1:3001/auth/register"}; unrelated=127.0.0.1',
  );

  assert.equal(cookie, "");
});

test("only the exact Glass refresh-cookie names cross the staging boundary", () => {
  const cookie = glassCookieHeader(
    "analytics=discard; silicon_refresh=debug-token; " +
      "__Secure-silicon_refresh=secure-token; silicon_refresh_extra=discard",
  );

  assert.equal(
    cookie,
    "silicon_refresh=debug-token; __Secure-silicon_refresh=secure-token",
  );
});

test("proxy preserves the canonical TLS/HTTP boundary without mutating input", () => {
  const original = {
    host: "127.0.0.1:8002",
    origin: "http://127.0.0.1:3001",
    cookie: "posthog=http://127.0.0.1:3001",
    authorization: "Bearer retained",
  };

  const result = upstreamHeaders(original, {
    canonicalHost: "glass.teamofsilicons.com",
    canonicalOrigin: "https://interface.teamofsilicons.com",
  });

  assert.deepEqual(result, {
    host: "glass.teamofsilicons.com",
    origin: "https://interface.teamofsilicons.com",
    authorization: "Bearer retained",
  });
  assert.equal(original.cookie, "posthog=http://127.0.0.1:3001");
});

test("only the exact local UI origin receives credentialed CORS headers", () => {
  const upstream = {
    "access-control-allow-origin": "https://interface.teamofsilicons.com",
    "access-control-allow-credentials": "true",
    vary: "Accept-Encoding",
  };
  const config = { localOrigin: "http://127.0.0.1:3001" };

  assert.deepEqual(
    downstreamHeaders(upstream, "http://127.0.0.1:3001", config),
    {
      "access-control-allow-origin": "http://127.0.0.1:3001",
      "access-control-allow-credentials": "true",
      vary: "Accept-Encoding, Origin",
    },
  );
  assert.deepEqual(
    downstreamHeaders(upstream, "https://attacker.example", config),
    { vary: "Accept-Encoding" },
  );
});
