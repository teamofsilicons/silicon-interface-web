import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("desktop shell caches normalized chat navigation and serves it offline", async () => {
  const handlers = new Map();
  const stored = new Map();
  const cache = {
    async match(key) {
      return stored.get(typeof key === "string" ? key : key.url);
    },
    async put(key, value) {
      stored.set(typeof key === "string" ? key : key.url, value);
    },
  };
  const caches = {
    async keys() { return []; },
    async delete() { return true; },
    async open() { return cache; },
  };
  const self = {
    location: { origin: "https://interface.teamofsilicons.com" },
    addEventListener(type, handler) { handlers.set(type, handler); },
    skipWaiting() {},
    clients: {
      claim: async () => undefined,
      matchAll: async () => [],
      openWindow: async () => null,
    },
    registration: {
      getNotifications: async () => [],
      showNotification: async () => undefined,
    },
  };
  const shell = {
    ok: true,
    type: "basic",
    marker: "cached-chat-shell",
    clone() { return this; },
  };
  let online = true;
  const source = await fs.readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    self,
    caches,
    indexedDB: undefined,
    navigator: {},
    fetch: async () => {
      if (!online) throw new Error("offline");
      return shell;
    },
    Request,
    Response,
    URL,
    URLSearchParams,
    Date,
  });

  const request = {
    method: "GET",
    mode: "navigate",
    url: "https://interface.teamofsilicons.com/chat?room=01KXDKNQWFVM04YQDZMD47CY76",
  };
  let responsePromise;
  handlers.get("fetch")({
    request,
    respondWith(value) { responsePromise = value; },
  });
  assert.equal(await responsePromise, shell);
  assert.equal(
    stored.get("https://interface.teamofsilicons.com/chat"),
    shell,
  );

  online = false;
  handlers.get("fetch")({
    request: { ...request, url: request.url.replace("76", "77") },
    respondWith(value) { responsePromise = value; },
  });
  assert.equal((await responsePromise).marker, "cached-chat-shell");
});
