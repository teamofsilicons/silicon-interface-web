const assert = require("node:assert/strict");
const { statSync } = require("node:fs");
const { mkdtemp, mkdir, rm, symlink, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const feeds = [
  ["darwin/x64", "latest-mac.yml"],
  ["darwin/arm64", "latest-mac.yml"],
  ["win32/x64", "latest.yml"],
  ["win32/arm64", "latest.yml"],
  ["linux/x64", "latest-linux.yml"],
  ["linux/arm64", "latest-linux.yml"],
];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "silicon-release-publish-"));
  for (const [feed, pointer] of feeds) {
    const directory = path.join(root, feed);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `Silicon-0.1.0-${feed.replace("/", "-")}.bin`), "payload");
    await writeFile(path.join(directory, pointer), "version: 0.1.0\n");
  }
  await writeFile(path.join(root, "desktop.sbom.cdx.json"), "{}\n");
  await writeFile(path.join(root, "SHA256SUMS.txt"), "hashes\n");
  await writeFile(path.join(root, "release-manifest.json"), "{}\n");
  return root;
}

function fakeAws(initialObjects = new Map()) {
  const objects = new Map(initialObjects);
  const calls = [];
  const run = (args, { allowNotFound = false } = {}) => {
    calls.push(args);
    if (args[0] === "s3api" && args[1] === "head-object") {
      const key = args[args.indexOf("--key") + 1];
      if (!objects.has(key)) {
        if (allowNotFound) return null;
        throw new Error(`missing fake object: ${key}`);
      }
      return JSON.stringify(objects.get(key));
    }
    if (args[0] === "s3" && args[1] === "cp") {
      const source = args[2];
      const destination = new URL(args[3]);
      const key = destination.pathname.slice(1);
      const metadata = args[args.indexOf("--metadata") + 1];
      objects.set(key, {
        ContentLength: statSync(source).size,
        Metadata: { sha256: metadata.slice("sha256=".length) },
      });
      return "";
    }
    if (args[0] === "cloudfront" && args[1] === "create-invalidation") return "{}";
    throw new Error(`unexpected fake AWS call: ${args.join(" ")}`);
  };
  return { run, calls, objects };
}

test("release publication uploads every payload before pointers and summaries", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { planRelease, mutableInvalidationPaths } = await import("../scripts/publish-release.mjs");
  const plan = await planRelease(root);

  assert.equal(plan.filter((entry) => entry.phase === "payload").length, 6);
  assert.equal(plan.filter((entry) => entry.phase === "pointer").length, 6);
  assert.equal(plan.filter((entry) => entry.phase === "summary").length, 3);
  assert.deepEqual([...new Set(plan.map((entry) => entry.phase))], ["payload", "pointer", "summary"]);
  assert.equal(plan.at(-1).relative, "release-manifest.json");
  assert.ok(plan.filter((entry) => entry.phase === "payload").every(
    (entry) => entry.cacheControl.includes("immutable") && /^[a-f0-9]{64}$/.test(entry.sha256),
  ));
  assert.ok(plan.filter((entry) => entry.phase !== "payload").every(
    (entry) => entry.cacheControl.includes("no-cache"),
  ));
  assert.deepEqual(
    mutableInvalidationPaths(plan),
    plan.filter((entry) => entry.phase !== "payload").map((entry) => `/${entry.key}`),
  );
});

test("release publication rejects a missing architecture pointer", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(path.join(root, "win32/arm64/latest.yml"));
  const { planRelease } = await import("../scripts/publish-release.mjs");
  await assert.rejects(() => planRelease(root), /missing win32\/arm64\/latest\.yml/);
});

test("release publication rejects surprise metadata and symbolic links", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { planRelease } = await import("../scripts/publish-release.mjs");

  await writeFile(path.join(root, "darwin/x64/other.yml"), "bad\n");
  await assert.rejects(() => planRelease(root), /expected exactly darwin\/x64\/latest-mac\.yml/);
  await rm(path.join(root, "darwin/x64/other.yml"));
  await symlink(path.join(root, "release-manifest.json"), path.join(root, "manifest-link"));
  await assert.rejects(() => planRelease(root), /rejects symbolic link/);
});

test("release publication rejects files outside an architecture feed", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { planRelease } = await import("../scripts/publish-release.mjs");

  await writeFile(path.join(root, "unexpected-installer.bin"), "bad\n");
  await assert.rejects(() => planRelease(root), /outside an architecture feed/);
});

test("release publication verifies payloads before activating pointers", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { planRelease, publishRelease } = await import("../scripts/publish-release.mjs");
  const expected = await planRelease(root);
  const fake = fakeAws();

  await publishRelease({
    releaseRoot: root,
    bucket: "silicon-release-test-bucket",
    distributionId: "E12345678",
    runAws: fake.run,
  });

  const uploadedKeys = fake.calls
    .filter((args) => args[0] === "s3" && args[1] === "cp")
    .map((args) => new URL(args[3]).pathname.slice(1));
  assert.deepEqual(uploadedKeys, expected.map((entry) => entry.key));
  const invalidation = fake.calls.find(
    (args) => args[0] === "cloudfront" && args[1] === "create-invalidation",
  );
  assert.deepEqual(
    invalidation.slice(invalidation.indexOf("--paths") + 1),
    expected.filter((entry) => entry.phase !== "payload").map((entry) => `/${entry.key}`),
  );
});

test("release publication refuses to replace an immutable payload", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { planRelease, publishRelease } = await import("../scripts/publish-release.mjs");
  const plan = await planRelease(root);
  const firstPayload = plan.find((entry) => entry.phase === "payload");
  const fake = fakeAws(new Map([[
    firstPayload.key,
    { ContentLength: firstPayload.bytes, Metadata: { sha256: "0".repeat(64) } },
  ]]));

  await assert.rejects(() => publishRelease({
    releaseRoot: root,
    bucket: "silicon-release-test-bucket",
    runAws: fake.run,
  }), /immutable release path conflict/);
  assert.equal(fake.calls.some((args) => args[0] === "s3" && args[1] === "cp"), false);
});
