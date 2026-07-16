import assert from "node:assert/strict";
import test from "node:test";

import {
  blocksRelease,
  flattenAdvisories,
  parsePnpmLockPackages,
} from "../../scripts/dependency-audit.mjs";

test("dependency audit extracts exact package versions from pnpm lock v9", () => {
  const packages = parsePnpmLockPackages(`lockfileVersion: '9.0'
packages:
  '@scope/example@1.2.3':
    resolution: {integrity: ignored}
  plain@4.5.6(peer@7.8.9):
    resolution: {integrity: ignored}
  plain@4.5.6:
    resolution: {integrity: ignored}
  workspace-only@workspace:*:
    resolution: {directory: ignored}
snapshots:
  plain@4.5.6: {}
`);
  assert.deepEqual(packages, {
    "@scope/example": ["1.2.3"],
    plain: ["4.5.6"],
  });
});

test("dependency audit validates, sorts, and gates advisory severity", () => {
  const advisories = flattenAdvisories({
    low_package: [{ severity: "low", title: "Low", vulnerable_versions: "<2", url: "https://low" }],
    high_package: [{ severity: "high", title: "High", vulnerable_versions: "<3", url: "https://high" }],
  });
  assert.deepEqual(advisories.map(({ module, severity }) => ({ module, severity })), [
    { module: "high_package", severity: "high" },
    { module: "low_package", severity: "low" },
  ]);
  assert.equal(blocksRelease(advisories[0]), true);
  assert.equal(blocksRelease(advisories[1]), false);
  assert.equal(blocksRelease(advisories[1], "low"), true);
  assert.throws(() => flattenAdvisories({ invalid: {} }), /invalid advisories/);
});
