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

test("protected calls wait for browser restoration before attaching credentials", async () => {
  const previousFetch = globalThis.fetch;
  let releaseRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  let protectedRequests = 0;

  authStore.clear("revoked");
  authStore.setCarbon(carbon);
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/refresh")) {
      markRefreshStarted();
      await refreshGate;
      return Response.json({ access: "restored-access" });
    }
    if (url.endsWith("/api/v1/carbons/me")) {
      protectedRequests += 1;
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer restored-access",
      );
      return Response.json(carbon);
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const request = api.me();
    await refreshStarted;
    await Promise.resolve();
    assert.equal(protectedRequests, 0);
    releaseRefresh();
    await request;
    assert.equal(protectedRequests, 1);
  } finally {
    globalThis.fetch = previousFetch;
    authStore.clear("revoked");
  }
});

test("missing browser authority logs out before a protected request is sent", async () => {
  const previousFetch = globalThis.fetch;
  let protectedRequests = 0;

  authStore.clear("revoked");
  authStore.setCarbon(carbon);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/api/v1/auth/refresh")) {
      return Response.json(
        { detail: "Browser session is missing.", code: "web_session_missing" },
        { status: 401 },
      );
    }
    protectedRequests += 1;
    throw new Error(`protected request should not be sent: ${url}`);
  };

  try {
    await assert.rejects(api.me(), (error) => error.status === 401);
    assert.equal(protectedRequests, 0);
    assert.equal(authStore.getAccess(), null);
    assert.equal(authStore.getCarbon(), null);
  } finally {
    globalThis.fetch = previousFetch;
    authStore.clear("revoked");
  }
});

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

test("an in-flight refresh cannot sign the user back in after logout", async () => {
  const previousFetch = globalThis.fetch;
  let releaseRefresh;
  let refreshStarted;
  const started = new Promise((resolve) => { refreshStarted = resolve; });
  const response = new Promise((resolve) => { releaseRefresh = resolve; });

  authStore.setTokens("access-before-logout", "refresh-before-logout", carbon);
  globalThis.fetch = async (input) => {
    if (!String(input).endsWith("/api/v1/auth/refresh")) {
      throw new Error(`unexpected request: ${input}`);
    }
    refreshStarted();
    return response;
  };

  try {
    const restoring = api.restoreWebSessionState();
    await started;
    authStore.clear();
    releaseRefresh(Response.json({ access: "late-access" }));

    assert.equal(await restoring, "anonymous");
    assert.equal(authStore.getAccess(), null);
    assert.equal(authStore.wasExplicitlyLoggedOut(), true);
  } finally {
    globalThis.fetch = previousFetch;
    authStore.clear("revoked");
  }
});

test("a confirmed anonymous refresh clears the stale local owner", async () => {
  const previousFetch = globalThis.fetch;
  authStore.setTokens("expired-access", "expired-refresh", carbon);
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/api/v1/auth/refresh")) {
      return Response.json({ detail: "refresh unavailable" }, { status: 400 });
    }
    if (String(input).endsWith("/api/v1/carbons/me")) {
      return Response.json({ detail: "expired" }, { status: 401 });
    }
    throw new Error(`unexpected request: ${input}`);
  };

  try {
    await assert.rejects(api.me(), (error) => error.status === 401);
    assert.equal(authStore.getAccess(), null);
    assert.equal(authStore.getCarbon(), null);
    assert.equal(authStore.wasExplicitlyLoggedOut(), false);
  } finally {
    globalThis.fetch = previousFetch;
    authStore.clear("revoked");
  }
});

test("a typed backend revocation clears the session without fabricating user logout", async () => {
  const previousFetch = globalThis.fetch;
  authStore.setTokens("revoked-access", "revoked-refresh", carbon);
  globalThis.fetch = async (input) => {
    if (String(input).endsWith("/api/v1/auth/refresh")) {
      return Response.json(
        { detail: "account disabled", code: "web_session_revoked" },
        { status: 401 },
      );
    }
    if (String(input).endsWith("/api/v1/carbons/me")) {
      return Response.json({ detail: "expired" }, { status: 401 });
    }
    throw new Error(`unexpected request: ${input}`);
  };

  try {
    await assert.rejects(api.me(), (error) => error.status === 401);
    assert.equal(authStore.getAccess(), null);
    assert.equal(authStore.getCarbon(), null);
    assert.equal(authStore.wasExplicitlyLoggedOut(), false);
  } finally {
    globalThis.fetch = previousFetch;
    authStore.clear("revoked");
  }
});

test("durability telemetry keeps the device binding required by authenticated endpoints", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const deviceId = "device-telemetry-binding";
  const payload = Buffer.from(JSON.stringify({ device_id: deviceId })).toString("base64url");
  authStore.setTokens(`header.${payload}.signature`, "refresh", carbon);
  globalThis.window = { atob: globalThis.atob };
  let observedDevice = null;
  globalThis.fetch = async (_input, init = {}) => {
    observedDevice = new Headers(init.headers).get("x-device-id");
    return new Response(null, { status: 202 });
  };

  try {
    await api.recordClientDurableCommits({
      schema: 1,
      platform: "web",
      counters: {
        draft: { attempted: 1, succeeded: 1, failed: 0 },
        send: { attempted: 0, succeeded: 0, failed: 0 },
      },
    });
    assert.equal(observedDevice, deviceId);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
    authStore.clear("revoked");
  }
});

test("message transport is not blocked by a stalled tracing lookup", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const values = new Map();
  globalThis.window = {
    atob: globalThis.atob,
    localStorage: {
      get length() { return values.size; },
      getItem: (key) => values.get(String(key)) ?? null,
      key: (index) => [...values.keys()][index] ?? null,
      removeItem: (key) => values.delete(String(key)),
      setItem: (key, value) => values.set(String(key), String(value)),
    },
    indexedDB: {
      // Simulate a browser storage implementation whose open request never
      // settles. Optional trace lookup must still yield to the actual POST.
      open: () => ({}),
    },
  };
  authStore.setTokens("access-for-send", "refresh-for-send", carbon);
  let fetchAt = 0;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/api\/v1\/rooms\/room-send\/events$/);
    fetchAt = Date.now();
    return Response.json({
      event_id: "01K00000000000000000000000",
      room: 1,
      sender_kind: "carbon",
      sender_id: 1,
      sender_handle: carbon.username,
      type: "m.text",
      content: { body: "bounded" },
      reply_to_event_id: "",
      is_final: true,
      created_at: new Date().toISOString(),
      edited_at: null,
      redacted_at: null,
      redaction_reason: "",
    });
  };

  const startedAt = Date.now();
  try {
    await api.sendEvent(
      "room-send",
      { type: "m.text", content: { body: "bounded" } },
      "client-stalled-trace",
    );
    assert.ok(fetchAt - startedAt >= 200);
    assert.ok(fetchAt - startedAt < 1_000);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
    authStore.clear("revoked");
  }
});
