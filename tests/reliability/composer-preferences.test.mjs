import assert from "node:assert/strict";
import test from "node:test";

import { composerEnterAction } from "../../src/lib/composer-preferences.ts";

test("send mode uses Enter to send and Shift+Enter for a newline", () => {
  assert.equal(composerEnterAction({ key: "Enter", behavior: "send" }), "send");
  assert.equal(
    composerEnterAction({ key: "Enter", behavior: "send", shiftKey: true }),
    "newline",
  );
});

test("newline mode uses Enter for a newline and command/control Enter to send", () => {
  assert.equal(composerEnterAction({ key: "Enter", behavior: "newline" }), "newline");
  assert.equal(
    composerEnterAction({ key: "Enter", behavior: "newline", metaKey: true }),
    "send",
  );
  assert.equal(
    composerEnterAction({ key: "Enter", behavior: "newline", ctrlKey: true }),
    "send",
  );
});

test("IME commits and unrelated keys never send", () => {
  assert.equal(
    composerEnterAction({
      key: "Enter",
      behavior: "send",
      isComposing: true,
    }),
    "ignore",
  );
  assert.equal(
    composerEnterAction({ key: "Enter", behavior: "send", keyCode: 229 }),
    "ignore",
  );
  assert.equal(composerEnterAction({ key: "a", behavior: "send" }), "ignore");
});
