"use strict";

const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { _private } = require("../scripts/esigner-sign.cjs");

const ENVIRONMENT = {
  SSL_ESIGNER_USERNAME: "user@example.test",
  SSL_ESIGNER_PASSWORD: "password-secret",
  SSL_ESIGNER_CREDENTIAL_ID: "credential-secret",
  SSL_ESIGNER_TOTP_SECRET: "totp-secret",
};

function withEnvironment(values, callback) {
  const previous = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
}

function candidate() {
  const root = mkdtempSync(path.join(os.tmpdir(), "silicon-esigner-"));
  const jar = path.join(root, "jar", _private.EXPECTED_JAR);
  const file = path.join(root, "Silicon Interface.exe");
  mkdirSync(path.join(root, "jar"));
  mkdirSync(path.join(root, "conf"));
  writeFileSync(jar, "pinned tool");
  writeFileSync(path.join(root, "conf", "code_sign_tool.properties"), "production endpoints");
  writeFileSync(file, "unsigned executable");
  return { file, jar };
}

test("eSigner hook signs one SHA-256 executable in place without a shell", async () => {
  const { file, jar } = candidate();
  await withEnvironment({ ...ENVIRONMENT, SSL_CODE_SIGN_JAR: jar }, async () => {
    const commands = [];
    await _private.signWith({ path: file, hash: "sha256" }, async (_java, args, options) => {
      commands.push(args);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.CODE_SIGN_TOOL_PATH, path.dirname(path.dirname(jar)));
      assert.equal(args.includes(`-input_file_path=${file}`), true);
      assert.equal(args.some((arg) => arg.startsWith("-password=")), true);
      if (args.includes("sign")) writeFileSync(file, "signed executable");
      return { stdout: "signed" };
    });
    assert.equal(commands.length, 2);
    assert.equal(commands[0].includes("scan_code"), true);
    assert.equal(commands[0].some((arg) => arg.startsWith("-totp_secret=")), false);
    assert.equal(commands[1].includes("sign"), true);
    assert.equal(commands[1].includes("-override=true"), true);
    assert.equal(commands.flat().some((arg) => arg.startsWith("-malware_block=")), false);
  });
});

test("eSigner hook rejects obsolete signing hashes", async () => {
  const { file, jar } = candidate();
  await withEnvironment({ ...ENVIRONMENT, SSL_CODE_SIGN_JAR: jar }, async () => {
    await assert.rejects(
      _private.signWith({ path: file, hash: "sha1" }, async () => {}),
      /only SHA-256 is allowed/,
    );
  });
});

test("eSigner hook redacts every cloud credential from failures", async () => {
  const { file, jar } = candidate();
  await withEnvironment({ ...ENVIRONMENT, SSL_CODE_SIGN_JAR: jar }, async () => {
    let failure;
    try {
      await _private.signWith({ path: file, hash: "sha256" }, async () => {
        const error = new Error("signer failed");
        error.stderr = Object.values(ENVIRONMENT).join(" ");
        throw error;
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    for (const secret of Object.values(ENVIRONMENT)) {
      assert.equal(failure.message.includes(secret), false);
    }
    assert.match(failure.message, /\[redacted\]/);
  });
});

test("eSigner hook fails closed when the malware scan rejects a file", async () => {
  const { file, jar } = candidate();
  await withEnvironment({ ...ENVIRONMENT, SSL_CODE_SIGN_JAR: jar }, async () => {
    let calls = 0;
    await assert.rejects(
      _private.signWith({ path: file, hash: "sha256" }, async () => {
        calls += 1;
        throw new Error("malware scan rejected candidate");
      }),
      /malware scan failed/,
    );
    assert.equal(calls, 1);
  });
});

test("eSigner hook refuses to sign bytes changed after malware scanning", async () => {
  const { file, jar } = candidate();
  await withEnvironment({ ...ENVIRONMENT, SSL_CODE_SIGN_JAR: jar }, async () => {
    let calls = 0;
    await assert.rejects(
      _private.signWith({ path: file, hash: "sha256" }, async (_java, args) => {
        calls += 1;
        if (args.includes("scan_code")) writeFileSync(file, "different unscanned executable");
        return { stdout: "scanned" };
      }),
      /changed after malware scan/,
    );
    assert.equal(calls, 1);
  });
});

test("eSigner hook fails closed when the signer leaves bytes unchanged", async () => {
  const { file, jar } = candidate();
  await withEnvironment({ ...ENVIRONMENT, SSL_CODE_SIGN_JAR: jar }, async () => {
    await assert.rejects(
      _private.signWith({ path: file, hash: "sha256" }, async () => ({ stdout: "ok" })),
      /without changing the input file/,
    );
  });
});
