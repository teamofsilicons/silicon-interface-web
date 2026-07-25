import assert from "node:assert/strict";
import test from "node:test";

const { createStructureRenderWatchdog } = await import(
  "../../src/lib/structure-render-watchdog.ts"
);

function fakeTimers() {
  let callback = null;
  let cleared = false;
  return {
    timers: {
      setTimeout(next) {
        callback = next;
        return "render-timeout";
      },
      clearTimeout(handle) {
        assert.equal(handle, "render-timeout");
        cleared = true;
      },
    },
    fire() {
      callback?.();
    },
    wasCleared() {
      return cleared;
    },
  };
}

test("a loaded structure chart cannot be replaced by its stale timeout", () => {
  const clock = fakeTimers();
  const results = [];
  const watchdog = createStructureRenderWatchdog(
    (result) => results.push(result),
    30_000,
    clock.timers,
  );

  watchdog.ready();
  clock.fire();
  watchdog.error();

  assert.deepEqual(results, ["ready"]);
  assert.equal(clock.wasCleared(), true);
});

test("an unfinished structure chart still fails closed once", () => {
  const clock = fakeTimers();
  const results = [];
  const watchdog = createStructureRenderWatchdog(
    (result) => results.push(result),
    30_000,
    clock.timers,
  );

  clock.fire();
  watchdog.ready();

  assert.deepEqual(results, ["error"]);
  assert.equal(clock.wasCleared(), true);
});

test("disposing the structure chart cancels its pending timeout", () => {
  const clock = fakeTimers();
  const results = [];
  const watchdog = createStructureRenderWatchdog(
    (result) => results.push(result),
    30_000,
    clock.timers,
  );

  watchdog.dispose();
  clock.fire();

  assert.deepEqual(results, []);
  assert.equal(clock.wasCleared(), true);
});
