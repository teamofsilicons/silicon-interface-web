import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../src/components/auth-guard.tsx", import.meta.url),
  "utf8",
);

test("valid sessions enter before non-authoritative browser setup finishes", () => {
  const entry = source.indexOf("setOk(true);", source.indexOf("installation registration retries"));
  const registration = source.indexOf("scheduleDeviceRegistration();", entry);
  const persistence = source.indexOf("void navigator.storage?.persist?.()", entry);
  assert.ok(entry >= 0);
  assert.ok(registration > entry);
  assert.ok(persistence > entry);
  assert.doesNotMatch(source, /await ensureDeviceRegistration\(\)/);
  assert.doesNotMatch(source, /await navigator\.storage\?\.persist\?\.\(\)/);
});

test("returning owners are released before network restoration settles", () => {
  const retainedEntry = source.indexOf("if (canPaintRetainedSession(");
  const boot = source.indexOf("void boot();", retainedEntry);
  assert.ok(retainedEntry >= 0);
  assert.ok(boot > retainedEntry);
  assert.match(
    source.slice(retainedEntry, boot),
    /authStore\.hasPersistedOwner\(\)/,
  );
});

test("a cleared session removes the mounted protected shell", () => {
  const subscription = source.indexOf("authStore.subscribe((change)");
  const cleared = source.indexOf('change !== "cleared"', subscription);
  const cover = source.indexOf("setOk(false);", cleared);
  const redirect = source.indexOf('router.replace("/auth/login")', cover);
  assert.ok(subscription >= 0);
  assert.ok(cleared > subscription);
  assert.ok(cover > cleared);
  assert.ok(redirect > cover);
});
