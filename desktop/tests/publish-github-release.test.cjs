const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const feeds = [
  ["darwin/x64", ["dmg", "zip"]],
  ["darwin/arm64", ["dmg", "zip"]],
  ["win32/x64", ["exe", "zip"]],
  ["win32/arm64", ["exe", "zip"]],
  ["linux/x64", ["AppImage", "deb"]],
  ["linux/arm64", ["AppImage", "deb"]],
];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "silicon-github-release-"));
  for (const [feed, extensions] of feeds) {
    const directory = path.join(root, feed);
    await mkdir(directory, { recursive: true });
    for (const extension of extensions) {
      await writeFile(
        path.join(directory, `Silicon-0.1.0-${feed.replace("/", "-")}.${extension}`),
        `${feed}-${extension}`,
      );
    }
    await writeFile(path.join(directory, feed.startsWith("darwin") ? "latest-mac.yml" : "latest.yml"), "ignored\n");
  }
  await writeFile(path.join(root, "desktop.sbom.cdx.json"), "{}\n");
  await writeFile(path.join(root, "SHA256SUMS.txt"), "hashes\n");
  await writeFile(path.join(root, "release-manifest.json"), "{}\n");
  return root;
}

function fakeGitHub() {
  let release = null;
  const calls = [];
  const run = (args, { allowNotFound = false } = {}) => {
    calls.push(args);
    if (args[0] === "api") {
      if (!release && allowNotFound) return null;
      return JSON.stringify(release);
    }
    if (args[0] === "release" && args[1] === "create") {
      release = { draft: true, assets: [] };
      return "";
    }
    if (args[0] === "release" && args[1] === "upload") {
      const source = args[3];
      release.assets.push({
        name: path.basename(source),
        size: statSync(source).size,
        digest: `sha256:${createHash("sha256").update(readFileSync(source)).digest("hex")}`,
      });
      return "";
    }
    if (args[0] === "release" && args[1] === "edit") {
      release.draft = false;
      return "";
    }
    throw new Error(`unexpected fake GitHub call: ${args.join(" ")}`);
  };
  return { run, calls, get release() { return release; }, set release(value) { release = value; } };
}

test("GitHub release remains a verified draft until explicit finalization", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { prepareGitHubRelease, finalizeGitHubRelease } = await import("../scripts/publish-github-release.mjs");
  const fake = fakeGitHub();

  const plan = await prepareGitHubRelease({
    releaseRoot: root,
    repository: "teamofsilicons/silicon-interface-web",
    tag: "desktop-v0.1.0",
    runGh: fake.run,
  });
  assert.equal(plan.length, 15);
  assert.equal(fake.release.draft, true);
  assert.equal(fake.release.assets.length, 15);
  assert.equal(fake.calls.some((args) => args.includes("--clobber")), false);

  await finalizeGitHubRelease({
    releaseRoot: root,
    repository: "teamofsilicons/silicon-interface-web",
    tag: "desktop-v0.1.0",
    runGh: fake.run,
  });
  assert.equal(fake.release.draft, false);
});

test("GitHub release resumes identical assets and rejects conflicting bytes", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { planGitHubAssets, prepareGitHubRelease } = await import("../scripts/publish-github-release.mjs");
  const plan = await planGitHubAssets(root);
  const first = plan[0];
  const fake = fakeGitHub();
  fake.release = {
    draft: true,
    assets: [{ name: first.name, size: first.bytes, digest: `sha256:${first.sha256}` }],
  };

  await prepareGitHubRelease({
    releaseRoot: root,
    repository: "teamofsilicons/silicon-interface-web",
    tag: "desktop-v0.1.0",
    runGh: fake.run,
  });
  assert.equal(fake.calls.filter((args) => args[0] === "release" && args[1] === "upload").length, 14);

  fake.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(() => prepareGitHubRelease({
    releaseRoot: root,
    repository: "teamofsilicons/silicon-interface-web",
    tag: "desktop-v0.1.0",
    runGh: fake.run,
  }), /conflicts with local bytes/);
});
