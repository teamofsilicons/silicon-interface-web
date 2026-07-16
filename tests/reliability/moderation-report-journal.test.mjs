import assert from "node:assert/strict";
import test from "node:test";

import { installBrowser, MemoryStorage } from "./helpers.mjs";

installBrowser(new MemoryStorage());
const browserEvents = new EventTarget();
window.addEventListener = browserEvents.addEventListener.bind(browserEvents);
window.removeEventListener = browserEvents.removeEventListener.bind(browserEvents);
window.dispatchEvent = browserEvents.dispatchEvent.bind(browserEvents);
class TestCustomEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}
globalThis.CustomEvent = TestCustomEvent;
const journal = await import("../../src/lib/moderation-report-journal.ts");

function input(ownerId = "owner-a") {
  return {
    ownerId,
    targetKind: "silicon",
    targetId: "01JREPORTTARGET00000000000",
    eventId: "01JREPORTEVENT000000000000",
    reason: "harassment",
    details: "Repeated unwanted messages",
    now: 100,
  };
}

test("report intent is durable before transport and restores exact identity", async () => {
  const intent = journal.createModerationReportIntent(input("owner-durable"));
  await journal.writeModerationReportIntent(intent);

  const restored = await journal.readModerationReportIntent(intent.ownerId, intent.clientId);
  assert.deepEqual(restored, intent);
  assert.equal(
    (await journal.listModerationReportIntents(intent.ownerId))[0].clientId,
    intent.clientId,
  );
});

test("retry and accepted receipts reuse the original immutable client identity", async () => {
  const intent = journal.createModerationReportIntent(input("owner-retry"));
  await journal.writeModerationReportIntent(intent);
  await journal.writeModerationReportIntent({
    ...intent,
    state: "retry_wait",
    attempts: 1,
    nextAttemptAt: 5_000,
    errorCode: "transport_unavailable",
    updatedAt: 200,
  });
  await journal.writeModerationReportIntent({
    ...intent,
    state: "accepted",
    attempts: 2,
    nextAttemptAt: null,
    reportId: "01JREPORTRECEIPT0000000000",
    errorCode: null,
    updatedAt: 300,
  });

  const restored = await journal.readModerationReportIntent(intent.ownerId, intent.clientId);
  assert.equal(restored?.clientId, intent.clientId);
  assert.equal(restored?.state, "accepted");
  assert.equal(restored?.reportId, "01JREPORTRECEIPT0000000000");
  assert.equal(restored?.targetId, intent.targetId);
  assert.equal(restored?.details, intent.details);
});

test("a newly durable retry deadline wakes the online recovery worker exactly once", async () => {
  const intent = journal.createModerationReportIntent(input("owner-live-retry"));
  const notifications = [];
  const listener = (event) => notifications.push(event.detail);
  window.addEventListener(journal.MODERATION_REPORT_RETRY_SCHEDULED_EVENT, listener);
  try {
    await journal.writeModerationReportIntent(intent);
    assert.equal(notifications.length, 0, "pending creation does not arm a retry timer");

    await journal.writeModerationReportIntent({
      ...intent,
      state: "retry_wait",
      attempts: 1,
      nextAttemptAt: 5_000,
      errorCode: "transport_unavailable",
      updatedAt: 200,
    });
    assert.deepEqual(notifications, [{
      ownerId: intent.ownerId,
      clientId: intent.clientId,
      nextAttemptAt: 5_000,
    }]);

    await journal.writeModerationReportIntent({
      ...intent,
      state: "accepted",
      attempts: 2,
      nextAttemptAt: null,
      reportId: "01JREPORTRECEIPT0000000000",
      errorCode: null,
      updatedAt: 300,
    });
    assert.equal(notifications.length, 1, "terminal journal writes do not wake recovery");
  } finally {
    window.removeEventListener(journal.MODERATION_REPORT_RETRY_SCHEDULED_EVENT, listener);
  }
});

test("a report client id cannot be rebound to another target or payload", async () => {
  const intent = journal.createModerationReportIntent(input("owner-conflict"));
  await journal.writeModerationReportIntent(intent);

  await assert.rejects(
    journal.writeModerationReportIntent({
      ...intent,
      targetId: "01JDIFFERENTTARGET000000000",
      updatedAt: 400,
    }),
    /cannot be rebound/,
  );
  const restored = await journal.readModerationReportIntent(intent.ownerId, intent.clientId);
  assert.equal(restored?.targetId, intent.targetId);
});

test("logout cleanup removes report evidence from both durable stores", async () => {
  const intent = journal.createModerationReportIntent(input("owner-cleanup"));
  await journal.writeModerationReportIntent(intent);
  await journal.clearModerationReportsForOwner(intent.ownerId);
  assert.equal(
    await journal.readModerationReportIntent(intent.ownerId, intent.clientId),
    null,
  );
});

test("logout cleanup removes IndexedDB evidence even when the mirror conflicts", async () => {
  const intent = journal.createModerationReportIntent(input("owner-conflicted-cleanup"));
  await journal.writeModerationReportIntent(intent);
  const mirrorKey = `silicon:moderation-report:v1:${encodeURIComponent(intent.ownerId)}:${encodeURIComponent(intent.clientId)}`;
  window.localStorage.setItem(mirrorKey, JSON.stringify({
    ...intent,
    targetId: "01JDIFFERENTTARGET000000000",
  }));

  await assert.rejects(
    journal.readModerationReportIntent(intent.ownerId, intent.clientId),
    /identity conflict/,
  );
  await journal.clearModerationReportsForOwner(intent.ownerId);

  assert.equal(
    await journal.readModerationReportIntent(intent.ownerId, intent.clientId),
    null,
  );
});
