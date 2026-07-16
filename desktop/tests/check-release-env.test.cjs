"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const script = path.join(__dirname, "..", "scripts", "check-release-env.mjs");

function check(platform, environment) {
  return spawnSync(process.execPath, [script, platform], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });
}

test("release environment supports the legacy trusted PFX path", () => {
  const result = check("win", { WIN_CSC_LINK: "archive", WIN_CSC_KEY_PASSWORD: "password" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /win\/pfx/);
});

test("release environment supports SSL.com cloud-HSM signing", () => {
  const result = check("win", {
    WINDOWS_SIGNING_PROVIDER: "sslcom-esigner",
    SSL_CODE_SIGN_JAR: "tool.jar",
    SSL_ESIGNER_USERNAME: "username",
    SSL_ESIGNER_PASSWORD: "password",
    SSL_ESIGNER_CREDENTIAL_ID: "credential",
    SSL_ESIGNER_TOTP_SECRET: "totp",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /win\/sslcom-esigner/);
});

test("release environment rejects unknown or incomplete Windows signers", () => {
  const unknown = check("win", { WINDOWS_SIGNING_PROVIDER: "unknown" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unsupported Windows signing provider/);

  const incomplete = check("win", { WINDOWS_SIGNING_PROVIDER: "sslcom-esigner" });
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /SSL_CODE_SIGN_JAR/);
});
