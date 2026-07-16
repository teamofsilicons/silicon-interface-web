const assert = require("node:assert/strict");
const { chmod, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const script = path.resolve(__dirname, "../scripts/configure-esigner-github.sh");

async function mockGh({ missingSecret = "", provider = "sslcom-esigner", publisher = "Jane Q. Example" } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "silicon-esigner-gh-"));
  const executable = path.join(directory, "gh");
  const secrets = [
    "SSL_ESIGNER_USERNAME",
    "SSL_ESIGNER_PASSWORD",
    "SSL_ESIGNER_CREDENTIAL_ID",
    "SSL_ESIGNER_TOTP_SECRET",
  ].filter((name) => name !== missingSecret).join("\\n");
  await writeFile(executable, `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "auth status") exit 0 ;;
  "secret list") printf '%b\\n' '${secrets}' ;;
  "variable list")
    if [[ "$*" == *WINDOWS_SIGNING_PROVIDER* ]]; then printf '%s\\n' '${provider}'
    elif [[ "$*" == *WINDOWS_PUBLISHER_NAME* ]]; then printf '%s\\n' '${publisher}'
    else exit 3
    fi
    ;;
  *) exit 4 ;;
esac
`);
  await chmod(executable, 0o755);
  return directory;
}

function runCheck(mockDirectory, publisher = "Jane Q. Example") {
  return spawnSync("bash", [script, "--publisher-name", publisher, "--check"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${mockDirectory}:${process.env.PATH}` },
  });
}

test("eSigner GitHub checker accepts only the complete exact configuration", async () => {
  const mockDirectory = await mockGh();
  const result = runCheck(mockDirectory);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configuration: PASS/);
});

test("eSigner GitHub checker rejects missing secrets and publisher drift", async () => {
  const missing = await mockGh({ missingSecret: "SSL_ESIGNER_TOTP_SECRET" });
  const missingResult = runCheck(missing);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /Missing encrypted Actions secret: SSL_ESIGNER_TOTP_SECRET/);

  const drifted = await mockGh({ publisher: "Jane Example" });
  const driftedResult = runCheck(drifted);
  assert.notEqual(driftedResult.status, 0);
  assert.match(driftedResult.stderr, /does not exactly match/);
});

test("configuration helper never accepts secret values as arguments or files", async () => {
  const source = await readFile(script, "utf8");
  assert.doesNotMatch(source, /--body/);
  assert.doesNotMatch(source, /--env-file/);
  assert.doesNotMatch(source, /mktemp|\.env|\btee\s/);
  for (const name of [
    "SSL_ESIGNER_USERNAME",
    "SSL_ESIGNER_PASSWORD",
    "SSL_ESIGNER_CREDENTIAL_ID",
    "SSL_ESIGNER_TOTP_SECRET",
  ]) {
    assert.match(source, new RegExp(name));
  }
});
