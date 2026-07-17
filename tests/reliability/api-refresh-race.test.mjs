import assert from "node:assert/strict";
import test from "node:test";

import { api } from "../../src/lib/api.ts";
import { authStore } from "../../src/lib/auth.ts";

const carbon = {
  carbon_id: "carbon-refresh-race",
  username: "refresh-race",
  name: "Refresh Race",
  tagline: "",
  timezone: "UTC",
  is_staff: false,
  email: "",
  phone: "",
  profile_photo_key: "",
  profile_photo_url: null,
  profile_ascii_url: null,
  email_verified_at: null,
  phone_verified_at: null,
  created_at: "",
};

test("late 401 responses reuse a concurrently refreshed access token", async () => {
  const previousFetch = globalThis.fetch;
  let releaseLate401;
  const late401 = new Promise((resolve) => {
    releaseLate401 = resolve;
  });
  let oldTokenRequests = 0;
  let refreshRequests = 0;

  authStore.setTokens("access-old", "refresh-old", carbon);
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const authorization = new Headers(init.headers).get("authorization");
    if (url.endsWith("/api/v1/auth/refresh")) {
      refreshRequests += 1;
      return Response.json({ access: "access-new", refresh: "refresh-new" });
    }
    if (url.endsWith("/api/v1/carbons/me") && authorization === "Bearer access-old") {
      oldTokenRequests += 1;
      if (oldTokenRequests === 2) await late401;
      return Response.json({ detail: "expired" }, { status: 401 });
    }
    if (url.endsWith("/api/v1/carbons/me") && authorization === "Bearer access-new") {
      return Response.json(carbon);
    }
    throw new Error(`unexpected request: ${url} (${authorization})`);
  };

  try {
    const first = api.me();
    const second = api.me();
    await first;
    releaseLate401();
    await second;
    assert.equal(refreshRequests, 1);
  } finally {
    globalThis.fetch = previousFetch;
    authStore.expireAccess();
  }
});
