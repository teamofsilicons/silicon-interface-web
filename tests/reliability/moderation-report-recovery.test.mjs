import assert from "node:assert/strict";
import test from "node:test";

import { createModerationReportRecoveryScheduler } from "../../src/lib/moderation-report-recovery.ts";

function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    clock: {
      now: () => now,
      setTimeout(callback, delayMs) {
        const id = nextId++;
        timers.set(id, { callback, at: now + delayMs });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    timerCount: () => timers.size,
    advanceTo(value) {
      now = value;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, timer] of due) {
        if (!timers.delete(id)) continue;
        timer.callback();
      }
    },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("a deadline scheduled after mount runs recovery when it becomes due", async () => {
  const fake = fakeClock(1_000);
  let recoveries = 0;
  const scheduler = createModerationReportRecoveryScheduler({
    clock: fake.clock,
    recover: async () => {
      recoveries += 1;
      return null;
    },
  });

  scheduler.schedule(2_000);
  assert.equal(fake.timerCount(), 1);
  fake.advanceTo(1_999);
  assert.equal(recoveries, 0);
  fake.advanceTo(2_000);
  await settle();
  assert.equal(recoveries, 1);
  assert.equal(fake.timerCount(), 0);
});

test("repeated notifications retain one timer and never postpone an earlier retry", async () => {
  const fake = fakeClock(1_000);
  let recoveries = 0;
  const scheduler = createModerationReportRecoveryScheduler({
    clock: fake.clock,
    recover: async () => {
      recoveries += 1;
      return null;
    },
  });

  scheduler.schedule(5_000);
  scheduler.schedule(5_000);
  scheduler.schedule(6_000);
  assert.equal(fake.timerCount(), 1);
  scheduler.schedule(4_000);
  assert.equal(fake.timerCount(), 1);

  fake.advanceTo(4_000);
  await settle();
  assert.equal(recoveries, 1);
  fake.advanceTo(6_000);
  await settle();
  assert.equal(recoveries, 1, "superseded timers cannot create retry storms");
});

test("cancel removes the timer and ignores future scheduling", async () => {
  const fake = fakeClock(1_000);
  let recoveries = 0;
  const scheduler = createModerationReportRecoveryScheduler({
    clock: fake.clock,
    recover: async () => {
      recoveries += 1;
      return null;
    },
  });

  scheduler.schedule(2_000);
  scheduler.cancel();
  scheduler.schedule(1_500);
  scheduler.wake();
  assert.equal(fake.timerCount(), 0);
  fake.advanceTo(3_000);
  await settle();
  assert.equal(recoveries, 0);
});

test("cancel during an in-flight scan cannot arm its returned deadline", async () => {
  const fake = fakeClock(1_000);
  let release;
  const scheduler = createModerationReportRecoveryScheduler({
    clock: fake.clock,
    recover: async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return 2_000;
    },
  });

  scheduler.wake();
  await settle();
  scheduler.cancel();
  release();
  await settle();
  assert.equal(fake.timerCount(), 0);
});

test("wakes during an in-flight scan coalesce into one follow-up scan", async () => {
  const fake = fakeClock(1_000);
  let releaseFirst;
  let recoveries = 0;
  const scheduler = createModerationReportRecoveryScheduler({
    clock: fake.clock,
    recover: async () => {
      recoveries += 1;
      if (recoveries === 1) {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return null;
    },
  });

  scheduler.wake();
  await settle();
  scheduler.wake();
  scheduler.wake();
  releaseFirst();
  await settle();
  await settle();
  assert.equal(recoveries, 2);
  assert.equal(fake.timerCount(), 0);
});
