import assert from "node:assert/strict";
import test from "node:test";

import { deleteDatabase, indexedDB, installBrowser } from "./helpers.mjs";

class TestCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

test("challenge journal survives and releases the unchanged outbox intent only after solve", async () => {
  await deleteDatabase("silicon-interface-abuse-challenges");
  await deleteDatabase("silicon-interface-outbox");
  const storage = installBrowser();
  window.dispatchEvent = () => true;
  window.addEventListener = () => undefined;
  globalThis.CustomEvent = TestCustomEvent;
  const journal = await import("../../src/lib/abuse-challenge-store.ts");
  const outbox = await import("../../src/lib/outbox.ts");
  const owner = "alice";
  const challenge = journal.challengeFromErrorBody({
    code: "challenge_required",
    challenge: {
      token: "signed-token",
      options: ["push", "captcha"],
      expires_at: "2030-01-01T00:00:00Z",
      captcha: {
        provider: "turnstile",
        site_key: "site",
        action: "abuse_challenge",
        cdata: "challenge-id",
      },
    },
  });
  assert.ok(challenge);
  await journal.rememberAbuseChallenge(owner, challenge);
  await outbox.enqueueOutbox(owner, {
    roomId: "room-1",
    clientId: "client-1",
    body: "private unsent body",
    at: 1,
  });
  await outbox.blockOutboxForChallenge(owner, "client-1", challenge, 2);

  let row = (await outbox.listOutbox(owner))[0];
  assert.equal(row.state, "challenge");
  assert.equal(row.challenge.token, "signed-token");
  assert.equal(row.body, "private unsent body");
  assert.equal((await journal.listAbuseChallenges(owner))[0].captcha.cdata, "challenge-id");

  await journal.removeAbuseChallenge(owner, challenge.token);
  await outbox.releaseOutboxChallenge(owner, challenge.token);
  row = (await outbox.listOutbox(owner))[0];
  assert.equal(row.state, "queued");
  assert.equal(row.challenge, undefined);
  assert.equal(row.body, "private unsent body");
  assert.equal(storage.getItem("silicon-interface:abuse-challenges:alice"), "[]");
});

test("invalid challenge bodies are never journaled", async () => {
  const journal = await import("../../src/lib/abuse-challenge-store.ts");
  assert.equal(journal.challengeFromErrorBody({ code: "challenge_required" }), null);
  assert.equal(
    journal.challengeFromErrorBody({
      code: "challenge_required",
      challenge: { token: "x", options: ["unknown"], expires_at: "tomorrow" },
    }),
    null,
  );
});

test("428 is never put into the ordinary automatic retry loop", async () => {
  const { decideClientRetry } = await import("../../src/lib/retry-policy.ts");
  assert.deepEqual(decideClientRetry(428, 1, 1_000, 1), {
    state: "blocked",
    nextAttemptAt: 0,
  });
});

test("solve-before-catch race cannot strand an outbox row in challenge state", async () => {
  const journal = await import("../../src/lib/abuse-challenge-store.ts");
  const outbox = await import("../../src/lib/outbox.ts");
  const challenge = {
    token: "race-token",
    options: ["push"],
    expires_at: "2030-01-01T00:00:00Z",
  };
  await outbox.enqueueOutbox("race-owner", {
    roomId: "room",
    clientId: "race-client",
    body: "never lose me",
    at: 2,
  });
  await journal.markAbuseChallengeSolved("race-owner", challenge.token);
  await outbox.blockOutboxForChallenge("race-owner", "race-client", challenge, 1);
  const row = (await outbox.listOutbox("race-owner"))[0];
  assert.equal(row.state, "queued");
  assert.equal(row.body, "never lose me");
});

test("service-worker proof storage is consumed by token and then removed", async () => {
  await deleteDatabase("silicon-interface-abuse-proofs");
  installBrowser();
  const proofStore = await import("../../src/lib/abuse-proof-store.ts");
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("silicon-interface-abuse-proofs", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("proofs", { keyPath: "token" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = db.transaction("proofs", "readwrite");
  transaction.objectStore("proofs").put({ token: "signed-token", answer: "secret-proof" });
  await new Promise((resolve) => { transaction.oncomplete = resolve; });

  assert.equal(await proofStore.readAbuseProof("signed-token"), "secret-proof");
  await proofStore.removeAbuseProof("signed-token");
  assert.equal(await proofStore.readAbuseProof("signed-token"), null);
  db.close();
});
