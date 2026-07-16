"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  desktopSmokeProfilePath,
  desktopSmokeResultPath,
  parseDesktopSmokeToken,
  writeDesktopSmokeResult,
} = require("../compiled/smoke.js");

test("desktop smoke tokens cannot escape the temporary directory", () => {
  const token = "ci_0123456789abcdef";
  assert.equal(parseDesktopSmokeToken(token), token);
  assert.equal(parseDesktopSmokeToken("too-short"), null);
  assert.equal(parseDesktopSmokeToken("../../outside-0123456789"), null);
  assert.equal(
    desktopSmokeResultPath("/tmp/silicon", token),
    path.join("/tmp/silicon", `silicon-interface-smoke-${token}.json`),
  );
  assert.equal(
    desktopSmokeProfilePath("/tmp/silicon", token),
    path.join("/tmp/silicon", `silicon-interface-smoke-profile-${token}`),
  );
});

test("desktop smoke result is exclusive and machine-readable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "silicon-smoke-test-"));
  const token = "ci_0123456789abcdef";
  try {
    const resultPath = await writeDesktopSmokeResult(directory, token, {
      status: "ready",
      url: "https://interface.teamofsilicons.com/chat",
    });
    const record = JSON.parse(await readFile(resultPath, "utf8"));
    assert.equal(record.schema, 1);
    assert.equal(record.status, "ready");
    assert.equal(record.url, "https://interface.teamofsilicons.com/chat");
    assert.equal(record.pid, process.pid);
    assert.match(record.recordedAt, /^\d{4}-\d{2}-\d{2}T/);

    await assert.rejects(
      writeDesktopSmokeResult(directory, token, {
        status: "load-failed",
        url: "https://interface.teamofsilicons.com/",
      }),
      { code: "EEXIST" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
