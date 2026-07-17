import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../src/components/auth-guard.tsx", import.meta.url),
  "utf8",
);

test("valid sessions enter before non-authoritative browser setup finishes", () => {
  const entry = source.indexOf("if (alive) setOk(true);");
  const registration = source.indexOf("void ensureDeviceRegistration()", entry);
  const persistence = source.indexOf("void navigator.storage?.persist?.()", entry);
  assert.ok(entry >= 0);
  assert.ok(registration > entry);
  assert.ok(persistence > entry);
  assert.doesNotMatch(source, /await ensureDeviceRegistration\(\)/);
  assert.doesNotMatch(source, /await navigator\.storage\?\.persist\?\.\(\)/);
});
