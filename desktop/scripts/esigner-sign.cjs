"use strict";

const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { lstat, readFile } = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const EXPECTED_JAR = "code_sign_tool-1.3.2.jar";
const REQUIRED_SECRETS = [
  "SSL_ESIGNER_USERNAME",
  "SSL_ESIGNER_PASSWORD",
  "SSL_ESIGNER_CREDENTIAL_ID",
  "SSL_ESIGNER_TOTP_SECRET",
];

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`eSigner: missing ${name}`);
  }
  return value;
}

function redact(value, secrets) {
  let output = String(value ?? "");
  for (const secret of secrets) {
    if (secret) {
      output = output.split(secret).join("[redacted]");
    }
  }
  return output;
}

async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function signWith(configuration, run) {
  const file = path.resolve(String(configuration?.path ?? ""));
  const hash = String(configuration?.hash ?? "").toLowerCase();
  if (hash !== "sha256") {
    throw new Error(`eSigner: only SHA-256 is allowed, received ${hash || "none"}`);
  }
  if (![".dll", ".exe"].includes(path.extname(file).toLowerCase())) {
    throw new Error(`eSigner: refusing unsupported file type ${path.extname(file) || "none"}`);
  }

  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) {
    throw new Error("eSigner: input must be a nonempty regular file");
  }

  const jar = path.resolve(requireEnvironment("SSL_CODE_SIGN_JAR"));
  if (path.basename(jar) !== EXPECTED_JAR) {
    throw new Error(`eSigner: expected the pinned ${EXPECTED_JAR}`);
  }
  const jarInfo = await lstat(jar);
  if (!jarInfo.isFile() || jarInfo.isSymbolicLink() || jarInfo.size === 0) {
    throw new Error("eSigner: signing tool must be a nonempty regular file");
  }

  const values = Object.fromEntries(REQUIRED_SECRETS.map((name) => [name, requireEnvironment(name)]));
  const secrets = Object.values(values);
  const java = process.env.SSL_CODE_SIGN_JAVA?.trim()
    || (process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
      : "java");
  const before = await sha256(file);
  const args = [
    "-Xmx1024m",
    "-jar",
    jar,
    "sign",
    `-username=${values.SSL_ESIGNER_USERNAME}`,
    `-password=${values.SSL_ESIGNER_PASSWORD}`,
    `-credential_id=${values.SSL_ESIGNER_CREDENTIAL_ID}`,
    `-totp_secret=${values.SSL_ESIGNER_TOTP_SECRET}`,
    "-program_name=Silicon Interface",
    `-input_file_path=${file}`,
    "-override=true",
    "-malware_block=true",
  ];

  try {
    await run(java, args, {
      windowsHide: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const details = redact(error?.stderr || error?.stdout || error?.message, secrets).trim();
    throw new Error(`eSigner failed${details ? `: ${details}` : ""}`);
  }

  const afterInfo = await lstat(file);
  const after = await sha256(file);
  if (!afterInfo.isFile() || afterInfo.size === 0 || before === after) {
    throw new Error("eSigner: signer returned without changing the input file");
  }
}

async function sign(configuration) {
  return signWith(configuration, execFileAsync);
}

module.exports = sign;
module.exports._private = { EXPECTED_JAR, redact, signWith };
