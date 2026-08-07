import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { withWebSessionAuthority } from "../../src/lib/web-session-authority.ts";

test("cookie-changing operations stay ordered without Web Locks", async () => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseFirst = resolve; });
  let secondStarted = false;

  const first = withWebSessionAuthority(async () => {
    firstStarted();
    await blocked;
  });
  await started;
  const second = withWebSessionAuthority(async () => {
    secondStarted = true;
  });
  await Promise.resolve();
  assert.equal(secondStarted, false);

  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(secondStarted, true);
});

test("interactive auth verifies the cookie before entering protected UI", async () => {
  const login = await readFile(
    new URL("../../src/app/auth/login/page.tsx", import.meta.url),
    "utf8",
  );
  const loginTokens = login.indexOf("authStore.setTokens(r.access");
  const loginConfirmation = login.indexOf("api.confirmWebSessionAfterLogin()", loginTokens);
  const loginNavigation = login.indexOf("router.replace(", loginConfirmation);
  assert.ok(loginTokens >= 0);
  assert.ok(loginConfirmation > loginTokens);
  assert.ok(loginNavigation > loginConfirmation);

  const onboarding = await readFile(
    new URL("../../src/app/onboarding/page.tsx", import.meta.url),
    "utf8",
  );
  const registration = onboarding.indexOf("authStore.setSession(session)");
  const registrationConfirmation = onboarding.indexOf(
    "api.confirmWebSessionAfterLogin()",
    registration,
  );
  assert.ok(registration >= 0);
  assert.ok(registrationConfirmation > registration);
});
