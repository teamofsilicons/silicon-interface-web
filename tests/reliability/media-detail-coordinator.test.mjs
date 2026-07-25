import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptMediaDetail,
  evictLocalMediaPreview,
  getLocalMediaPreview,
  retainLocalMediaPreview,
  subscribeMediaDetail,
} from "../../src/lib/media-cache.ts";

function ready(mediaId) {
  return {
    media: { media_id: mediaId, status: "ready" },
    download_url: `https://media.example/${mediaId}`,
  };
}

test("mounted copies and remounts share one ready-media request", async () => {
  const mediaId = `media-${Date.now()}-${Math.random()}`;
  let loads = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const loader = async () => {
    loads += 1;
    await pending;
    return ready(mediaId);
  };

  const firstReady = new Promise((resolve) => {
    const off = subscribeMediaDetail(mediaId, loader, (state) => {
      if (!state.value?.download_url) return;
      off();
      resolve();
    });
  });
  const secondReady = new Promise((resolve) => {
    const off = subscribeMediaDetail(mediaId, loader, (state) => {
      if (!state.value?.download_url) return;
      off();
      resolve();
    });
  });
  release();
  await Promise.all([firstReady, secondReady]);
  assert.equal(loads, 1);

  await new Promise((resolve) => {
    const off = subscribeMediaDetail(mediaId, loader, (state) => {
      if (!state.value?.download_url) return;
      off();
      resolve();
    });
  });
  assert.equal(loads, 1);
});

test("an offscreen pending response keeps its poll deadline across remounts", async () => {
  const mediaId = `pending-${Date.now()}-${Math.random()}`;
  let loads = 0;
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const loader = async () => {
    loads += 1;
    return response;
  };

  const unsubscribe = subscribeMediaDetail(mediaId, loader, () => {});
  unsubscribe();
  release({
    media: { media_id: mediaId, status: "pending" },
    download_url: null,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const remount = subscribeMediaDetail(mediaId, loader, () => {});
  assert.equal(loads, 1);
  remount();
});

test("a pushed scan verdict wakes mounted pending cards immediately", async () => {
  const mediaId = `pushed-${Date.now()}-${Math.random()}`;
  let loads = 0;
  let resolveReady;
  const rendered = new Promise((resolve) => { resolveReady = resolve; });
  const unsubscribe = subscribeMediaDetail(
    mediaId,
    async () => {
      loads += 1;
      return { media: { media_id: mediaId, status: "pending" }, download_url: null };
    },
    (state) => {
      if (state.value?.download_url) resolveReady();
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  acceptMediaDetail(mediaId, ready(mediaId));
  await rendered;
  assert.equal(loads, 1);
  unsubscribe();
});

test("just-uploaded bytes remain addressable by immutable media id", () => {
  const mediaId = `local-${Date.now()}-${Math.random()}`;
  const url = retainLocalMediaPreview(mediaId, new Blob(["hello"], { type: "text/plain" }));
  assert.ok(url?.startsWith("blob:"));
  assert.equal(getLocalMediaPreview(mediaId), url);
  evictLocalMediaPreview(mediaId);
  assert.equal(getLocalMediaPreview(mediaId), null);
});
