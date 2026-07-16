import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  classifyChangedPaths,
  decisionForCommit,
  isNonWebPath,
} from "../../scripts/vercel-ignore-build.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const IGNORE_SCRIPT = join(ROOT, "scripts", "vercel-ignore-build.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function writeFixture(root, filename, contents) {
  const absolute = join(root, filename);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function commit(root, message) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function runIgnore(root, commitSha) {
  const env = { ...process.env };
  if (commitSha === undefined) delete env.VERCEL_GIT_COMMIT_SHA;
  else env.VERCEL_GIT_COMMIT_SHA = commitSha;
  return spawnSync(process.execPath, [IGNORE_SCRIPT], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

test("only explicit non-web path families are skippable", () => {
  const nonWeb = [
    "desktop/src/main.ts",
    ".github/workflows/desktop.yml",
    "docs/desktop-release.md",
    "tests/deploy/release.test.mjs",
  ];
  for (const filename of nonWeb) assert.equal(isNonWebPath(filename), true, filename);

  const skip = classifyChangedPaths(nonWeb);
  assert.equal(skip.skip, true);
  for (const filename of [
    "src/app/page.tsx",
    "public/logo.svg",
    "scripts/deploy-production.mjs",
    "package.json",
    "pnpm-lock.yaml",
    "vercel.json",
    "README.md",
    "../desktop/main.ts",
    "desktop\\main.ts",
  ]) {
    assert.equal(isNonWebPath(filename), false, filename);
    assert.equal(classifyChangedPaths([filename]).skip, false, filename);
  }
  assert.equal(classifyChangedPaths([]).skip, false);
});

test("Vercel command skips a proven non-web commit and builds on every ambiguous or web case", () => {
  const repository = mkdtempSync(join(tmpdir(), "silicon-vercel-ignore-"));
  try {
    git(repository, ["init", "-q"]);
    git(repository, ["config", "user.email", "test@example.com"]);
    git(repository, ["config", "user.name", "Test"]);

    writeFixture(repository, "src/app/page.tsx", "export default function Page() {}\n");
    const rootSha = commit(repository, "initial web app");
    assert.equal(decisionForCommit({ cwd: repository, commitSha: rootSha }).skip, false);

    writeFixture(repository, "desktop/src/main.ts", "export {};\n");
    writeFixture(repository, ".github/workflows/desktop.yml", "name: desktop\n");
    writeFixture(repository, "docs/desktop.md", "desktop notes\n");
    writeFixture(repository, "tests/deploy/desktop.test.mjs", "// test\n");
    const nonWebSha = commit(repository, "desktop and supporting files");
    const nonWeb = runIgnore(repository, nonWebSha);
    assert.equal(nonWeb.status, 0, nonWeb.stderr);
    assert.match(nonWeb.stdout, /build skipped/);

    writeFixture(repository, "src/app/page.tsx", "export default function UpdatedPage() {}\n");
    const webSha = commit(repository, "change web app");
    const web = runIgnore(repository, webSha);
    assert.equal(web.status, 1, web.stderr);
    assert.match(web.stdout, /web-relevant paths changed: src\/app\/page\.tsx/);

    mkdirSync(join(repository, "desktop"), { recursive: true });
    git(repository, ["mv", "src/app/page.tsx", "desktop/moved-web-page.tsx"]);
    const renameSha = commit(repository, "move web source into desktop tree");
    const rename = decisionForCommit({ cwd: repository, commitSha: renameSha });
    assert.equal(rename.skip, false);
    assert.match(rename.reason, /src\/app\/page\.tsx/);

    git(repository, ["commit", "--allow-empty", "-qm", "empty commit"]);
    const emptySha = git(repository, ["rev-parse", "HEAD"]);
    const empty = decisionForCommit({ cwd: repository, commitSha: emptySha });
    assert.equal(empty.skip, false);
    assert.match(empty.reason, /diff was empty/);

    const treeSha = git(repository, ["rev-parse", `${emptySha}^{tree}`]);
    const mergeSha = git(repository, [
      "commit-tree",
      treeSha,
      "-p",
      emptySha,
      "-p",
      webSha,
      "-m",
      "synthetic merge fixture",
    ]);
    const merge = decisionForCommit({ cwd: repository, commitSha: mergeSha });
    assert.equal(merge.skip, false);
    assert.match(merge.reason, /root and merge commits always build/);

    const cli = runIgnore(repository, undefined);
    assert.equal(cli.status, 1, cli.stderr);
    assert.match(cli.stdout, /VERCEL_GIT_COMMIT_SHA is unavailable/);

    const invalid = runIgnore(repository, "not-a-git-sha");
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stdout, /not a full Git SHA-1/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("vercel.json wires the tested ignore command", () => {
  const configuration = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  assert.equal(configuration.ignoreCommand, "node scripts/vercel-ignore-build.mjs");
});
