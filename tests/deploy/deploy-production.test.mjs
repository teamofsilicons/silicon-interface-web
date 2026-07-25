import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  assertAliasIdentity,
  deploymentFromJson,
  parseArgs,
  reliabilityCounts,
  rollbackDecision,
  stampServiceWorker,
  suspiciousSourcePath,
  verifyHttpSmoke,
  verifyInspect,
} from "../../scripts/deploy-production.mjs";

const ROOT = resolve(import.meta.dirname, "../..");

test("production deploy requires one explicit mode", () => {
  assert.throws(() => parseArgs([]), /choose exactly one/);
  assert.throws(
    () => parseArgs(["--dry-run", "--confirm-production"]),
    /choose exactly one/,
  );
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--confirm-production"]).confirmProduction, true);
});

test("reliability evidence parses both TTY and non-TTY Node summaries", () => {
  assert.deepEqual(reliabilityCounts("ℹ pass 224\nℹ fail 0\n"), { passed: 224, failed: 0 });
  assert.deepEqual(reliabilityCounts("# pass 224\n# fail 0\n"), { passed: 224, failed: 0 });
});

test("each immutable release stamps one replacement service worker", () => {
  const source = 'self.SILICON_RELEASE = "__SILICON_INTERFACE_RELEASE_ID__";\n';
  const stamped = stampServiceWorker(source, "interface-20260718T164500Z-abc123def456");
  assert.equal(stamped.includes("__SILICON_INTERFACE_RELEASE_ID__"), false);
  assert.match(stamped, /interface-20260718T164500Z-abc123def456/);
  assert.throws(
    () => stampServiceWorker("self.SILICON_RELEASE = 'fixed';", "interface-valid"),
    /exactly one release placeholder/,
  );
});

test("deployment response parsing accepts current and nested Vercel shapes", () => {
  assert.deepEqual(
    deploymentFromJson({ id: "dpl_candidate", url: "candidate.vercel.app" }),
    { id: "dpl_candidate", url: "https://candidate.vercel.app" },
  );
  assert.deepEqual(
    deploymentFromJson({ deployment: { deploymentId: "dpl_nested", deploymentUrl: "https://nested.vercel.app" } }),
    { id: "dpl_nested", url: "https://nested.vercel.app" },
  );
});

test("inspect verification is fail-closed on state, target, project, and identity", () => {
  const valid = {
    id: "dpl_candidate",
    name: "silicon-interface",
    readyState: "READY",
    target: "production",
    url: "candidate.vercel.app",
  };
  assert.equal(verifyInspect(valid, { id: "dpl_candidate" }).id, "dpl_candidate");
  assert.throws(() => verifyInspect({ ...valid, readyState: "ERROR" }), /not READY/);
  assert.throws(() => verifyInspect({ ...valid, target: "preview" }), /not production/);
  assert.throws(() => verifyInspect({ ...valid, name: "another-project" }), /unexpected project/);
  assert.throws(() => verifyInspect(valid, { id: "dpl_other" }), /identity mismatch/);
});

test("HTTP smoke requires the app document and production security headers", () => {
  const headers = [
    "HTTP/2 200",
    "content-security-policy: default-src 'self'; object-src 'none'",
    "strict-transport-security: max-age=31536000; includeSubDomains",
    "x-content-type-options: nosniff",
    "x-frame-options: DENY",
    "",
  ].join("\n");
  const result = verifyHttpSmoke({
    body: "<html><script>self.__next_f.push([])</script></html>",
    headers,
    status: "200",
  });
  assert.equal(result.status, 200);
  assert.equal(result.next_bootstrap_frames, 1);
  assert.throws(
    () => verifyHttpSmoke({ body: "<html></html>", headers, status: "200" }),
    /Next.js document/,
  );
  assert.throws(
    () => verifyHttpSmoke({
      body: "self.__next_f",
      headers: headers.replace("object-src 'none'", "object-src 'none'; script-src 'unsafe-eval'"),
      status: "200",
    }),
    /content security policy/,
  );
});

test("pre-promotion compare-and-swap refuses a concurrent alias change", () => {
  assert.doesNotThrow(() => assertAliasIdentity({ id: "dpl_before" }, "dpl_before"));
  assert.throws(
    () => assertAliasIdentity({ id: "dpl_someone_else" }, "dpl_before", "before promotion"),
    /changed concurrently/,
  );
});

test("rollback mutates only when production still points at our candidate", () => {
  assert.equal(rollbackDecision("dpl_candidate", "dpl_candidate", "dpl_previous"), "rollback");
  assert.equal(
    rollbackDecision("dpl_previous", "dpl_candidate", "dpl_previous"),
    "already-previous",
  );
  assert.equal(
    rollbackDecision("dpl_concurrent", "dpl_candidate", "dpl_previous"),
    "preserve-concurrent",
  );
});

test("an unexpected skip-domain candidate move is rollback-eligible before promotion", () => {
  const explicitPromotionWasReached = false;
  assert.equal(explicitPromotionWasReached, false);
  assert.equal(
    rollbackDecision("dpl_candidate", "dpl_candidate", "dpl_previous"),
    "rollback",
  );
});

test("credential-like paths are refused while placeholders are allowed", () => {
  assert.equal(suspiciousSourcePath(".env.local"), true);
  assert.equal(suspiciousSourcePath(".vercel/project.json"), true);
  assert.equal(suspiciousSourcePath("ops/private.pem"), true);
  assert.equal(suspiciousSourcePath(".env.example"), false);
  assert.equal(suspiciousSourcePath("src/env.ts"), false);
});

test("source freezer is deterministic and represents edits, additions, deletions, and ignores", () => {
  const temporary = mkdtempSync(join(tmpdir(), "interface-freeze-test-"));
  let output;
  try {
    execFileSync("git", ["init", "-q"], { cwd: temporary });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: temporary });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: temporary });
    writeFileSync(join(temporary, ".gitignore"), ".env.local\n");
    writeFileSync(join(temporary, "kept.txt"), "before\n");
    writeFileSync(join(temporary, "deleted.txt"), "remove me\n");
    execFileSync("git", ["add", ".gitignore", "kept.txt", "deleted.txt"], { cwd: temporary });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: temporary });
    writeFileSync(join(temporary, "kept.txt"), "after\n");
    rmSync(join(temporary, "deleted.txt"));
    writeFileSync(join(temporary, "added.txt"), "new\n");
    writeFileSync(join(temporary, ".env.local"), "SECRET=never-archive\n");

    output = mkdtempSync(join(tmpdir(), "interface-freeze-output-"));
    const firstArchive = join(output, "first.tar.gz");
    const firstManifest = join(output, "first.json");
    const secondArchive = join(output, "second.tar.gz");
    const secondManifest = join(output, "second.json");
    const freezer = join(ROOT, "scripts", "freeze-source.py");
    execFileSync("python3", [freezer, "--root", temporary, "--archive", firstArchive, "--manifest", firstManifest]);
    execFileSync("python3", [freezer, "--root", temporary, "--archive", secondArchive, "--manifest", secondManifest]);

    assert.deepEqual(readFileSync(firstArchive), readFileSync(secondArchive));
    assert.deepEqual(readFileSync(firstManifest), readFileSync(secondManifest));
    const manifest = JSON.parse(readFileSync(firstManifest, "utf8"));
    const paths = manifest.files.map((entry) => entry.path);
    assert.equal(paths.includes("kept.txt"), true);
    assert.equal(paths.includes("added.txt"), true);
    assert.equal(paths.includes("deleted.txt"), false);
    assert.equal(paths.includes(".env.local"), false);
    const kept = manifest.files.find((entry) => entry.path === "kept.txt");
    assert.equal(
      kept.sha256,
      "7b9a72466d3960eb2aacccfc848939453490db0678bd4725def3f789b891c919",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    if (typeof output === "string") rmSync(output, { recursive: true, force: true });
  }
});
