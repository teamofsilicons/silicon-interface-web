import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applicationStateForConnectivity,
  MAX_SOCKET_BARRIER_RETRY_MS,
  socketBarrierRetryDelayMs,
  waitForSocketBarrierRetry,
} from "../../src/lib/socket-barrier-retry.ts";

test("socket barrier retry is bounded and jittered", () => {
  assert.equal(socketBarrierRetryDelayMs(0, 0), 500);
  assert.equal(socketBarrierRetryDelayMs(0, 0.5), 1_000);
  assert.equal(socketBarrierRetryDelayMs(0, 1), 1_500);
  assert.equal(
    socketBarrierRetryDelayMs(100, 0.5),
    MAX_SOCKET_BARRIER_RETRY_MS,
  );
});

test("only independent application reachability drives the global warning", () => {
  assert.equal(applicationStateForConnectivity("reachable"), "online");
  assert.equal(applicationStateForConnectivity("offline"), "offline");
  assert.equal(applicationStateForConnectivity("captive"), "captive");
  assert.equal(applicationStateForConnectivity("degraded"), "degraded");
});

test("an obsolete socket generation cancels its pending barrier retry", async () => {
  const controller = new AbortController();
  const pending = waitForSocketBarrierRetry(60_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
});

test("transient barrier failures retry on the accepted socket instead of reconnecting", async () => {
  const source = await readFile(
    new URL("../../src/lib/ws.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /while \(true\)[\s\S]+?onBarrierRef\.current/);
  assert.match(source, /waitForSocketBarrierRetry/);
  assert.doesNotMatch(
    source,
    /ws\.close\(CLIENT_SYNC_REPAIR_CLOSE_CODE, "sync failed"\)/,
  );
  assert.match(source, /applicationStateForConnectivity\(classification\)/);
});
