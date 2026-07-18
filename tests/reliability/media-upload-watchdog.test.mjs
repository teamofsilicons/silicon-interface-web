import assert from "node:assert/strict";
import test from "node:test";

import {
  UploadStalledError,
  xhrUpload,
} from "../../src/lib/media-upload.ts";
import { classifySendFailure } from "../../src/lib/send-failure.ts";

class FakeXHR {
  static latest = null;

  upload = {};
  status = 0;
  aborted = false;

  constructor() {
    FakeXHR.latest = this;
  }

  open() {}
  send() {}
  setRequestHeader() {}
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

test("an upload with no byte progress aborts and becomes a manual failure", async () => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const ref = { current: null };
    const pending = xhrUpload("https://upload.invalid", new FormData(), () => {}, ref, 0, 15);
    await assert.rejects(pending, (error) => error instanceof UploadStalledError);
    assert.equal(FakeXHR.latest.aborted, true);
    assert.equal(ref.current, null);

    const classified = classifySendFailure(new UploadStalledError(), {
      attempt: 1,
      now: 100,
      jitter: 1,
    });
    assert.equal(classified.state, "blocked");
    assert.equal(classified.failure.code, "upload_stalled");
    assert.equal(classified.failure.automatic, false);
    assert.deepEqual(classified.failure.correctionActions, ["resume_upload", "discard_local"]);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});

test("real byte progress resets the idle deadline", async () => {
  const original = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    const pending = xhrUpload(
      "https://upload.invalid",
      new FormData(),
      () => {},
      { current: null },
      0,
      50,
    );
    const xhr = FakeXHR.latest;
    setTimeout(() => xhr.upload.onprogress?.({ loaded: 1, total: 2, lengthComputable: true }), 30);
    setTimeout(() => {
      xhr.status = 204;
      xhr.onload?.();
    }, 60);
    await pending;
    assert.equal(xhr.aborted, false);
  } finally {
    globalThis.XMLHttpRequest = original;
  }
});
