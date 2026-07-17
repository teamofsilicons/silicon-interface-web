import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("desktop shell caches normalized chat navigation and serves it offline", async () => {
  const handlers = new Map();
  const stored = new Map();
  const deleted = [];
  const navigated = [];
  const cache = {
    async match(key) {
      return stored.get(typeof key === "string" ? key : key.url);
    },
    async put(key, value) {
      stored.set(typeof key === "string" ? key : key.url, value);
    },
  };
  const caches = {
    async keys() { return ["silicon-interface-shell-v3"]; },
    async delete(name) { deleted.push(name); return true; },
    async open() { return cache; },
  };
  const self = {
    location: { origin: "https://interface.teamofsilicons.com" },
    addEventListener(type, handler) { handlers.set(type, handler); },
    skipWaiting() {},
    clients: {
      claim: async () => undefined,
      matchAll: async () => [{
        url: "https://interface.teamofsilicons.com/chat?room=old",
        async navigate(url) { navigated.push(url); },
      }],
      openWindow: async () => null,
    },
    registration: {
      active: { scriptURL: "https://interface.teamofsilicons.com/sw.js?v=3" },
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
  assert.match(source, /silicon-interface-shell-v4/);
  assert.match(source, /SILICON_REPLACING_WORKER/);
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

  let activation;
  handlers.get("activate")({ waitUntil(value) { activation = value; } });
  await activation;
  assert.deepEqual(deleted, ["silicon-interface-shell-v3"]);
  assert.deepEqual(navigated, ["https://interface.teamofsilicons.com/chat?room=old"]);

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

test("the shell checks for a replacement while a tab remains open", async () => {
  const source = await fs.readFile(
    new URL("../../src/components/push-init.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /registration\.update\(\)/);
  assert.match(source, /controllerchange/);
  assert.match(source, /60_000/);
  assert.match(source, /window\.location\.reload\(\)/);
});
