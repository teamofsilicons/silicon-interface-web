import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_BANNER_CONFIRMATION_MS,
  createBannerConfirmationController,
} from "../../src/lib/banner-confirmation.ts";

function manualScheduler() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();

  const scheduler = {
    setTimeout(callback, delayMs) {
      const id = nextId++;
      pending.set(id, { callback, at: now + delayMs });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };

  return {
    scheduler,
    advance(delayMs) {
      const end = now + delayMs;
      while (true) {
        const due = [...pending.entries()]
          .filter(([, entry]) => entry.at <= end)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        const [id, entry] = due;
        pending.delete(id);
        now = entry.at;
        entry.callback();
      }
      now = end;
    },
    pendingCount() {
      return pending.size;
    },
  };
}

test("an app-wide condition stays hidden until continuously confirmed for two seconds", () => {
  const clock = manualScheduler();
  const changes = [];
  const confirmation = createBannerConfirmationController({
    onVisibilityChange: (key) => changes.push(key),
    scheduler: clock.scheduler,
  });

  confirmation.update("offline");
  clock.advance(APP_BANNER_CONFIRMATION_MS - 1);
  assert.deepEqual(changes, []);

  clock.advance(1);
  assert.deepEqual(changes, ["offline"]);
});

test("a transient or replaced condition can never expose a stale banner", () => {
  const clock = manualScheduler();
  const changes = [];
  const confirmation = createBannerConfirmationController({
    onVisibilityChange: (key) => changes.push(key),
    scheduler: clock.scheduler,
  });

  confirmation.update("offline");
  clock.advance(1_500);
  confirmation.update(null);
  clock.advance(1_000);
  assert.deepEqual(changes, []);

  confirmation.update("offline");
  clock.advance(1_500);
  confirmation.update("captive");
  clock.advance(500);
  assert.deepEqual(changes, []);
  clock.advance(1_500);
  assert.deepEqual(changes, ["captive"]);
});

test("recovery hides a confirmed banner immediately and cancels all work", () => {
  const clock = manualScheduler();
  const changes = [];
  const confirmation = createBannerConfirmationController({
    onVisibilityChange: (key) => changes.push(key),
    scheduler: clock.scheduler,
  });

  confirmation.update("offline");
  clock.advance(APP_BANNER_CONFIRMATION_MS);
  confirmation.update(null);

  assert.deepEqual(changes, ["offline", null]);
  assert.equal(clock.pendingCount(), 0);
});

test("the same state returning after a blip must be confirmed again", () => {
  const clock = manualScheduler();
  const changes = [];
  const firstOffline = { state: "offline" };
  const secondOffline = { state: "offline" };
  const confirmation = createBannerConfirmationController({
    onVisibilityChange: (condition) => changes.push(condition),
    scheduler: clock.scheduler,
  });

  confirmation.update(firstOffline);
  clock.advance(APP_BANNER_CONFIRMATION_MS);
  confirmation.update({ state: "online-transition" });
  confirmation.update(secondOffline);
  clock.advance(APP_BANNER_CONFIRMATION_MS - 1);
  assert.deepEqual(changes, [firstOffline, null]);

  clock.advance(1);
  assert.deepEqual(changes, [firstOffline, null, secondOffline]);
});

test("unmount disposal prevents late confirmation callbacks", () => {
  const clock = manualScheduler();
  const changes = [];
  const confirmation = createBannerConfirmationController({
    onVisibilityChange: (key) => changes.push(key),
    scheduler: clock.scheduler,
  });

  confirmation.update("storage");
  confirmation.dispose();
  clock.advance(APP_BANNER_CONFIRMATION_MS);

  assert.deepEqual(changes, []);
  assert.equal(clock.pendingCount(), 0);
});
