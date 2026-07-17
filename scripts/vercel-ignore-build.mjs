import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const NON_WEB_PREFIXES = Object.freeze([
  "desktop/",
  ".github/",
  "docs/",
  "tests/",
]);

function build(reason, changedPaths = []) {
  return { skip: false, reason, changedPaths };
}

function skip(reason, changedPaths) {
  return { skip: true, reason, changedPaths };
}

function runGit(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: null,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
}

function isUnambiguousGitPath(candidate) {
  return (
    typeof candidate === "string"
    && candidate.length > 0
    && !candidate.includes("\uFFFD")
    && !candidate.includes("\\")
    && !candidate.startsWith("/")
    && !candidate.endsWith("/")
    && !candidate.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  );
}

export function isNonWebPath(candidate) {
  if (!isUnambiguousGitPath(candidate)) return false;
  return NON_WEB_PREFIXES.some((prefix) => candidate.startsWith(prefix));
}

export function classifyChangedPaths(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) {
    return build("the commit diff was empty or unavailable");
  }
  if (changedPaths.some((candidate) => !isUnambiguousGitPath(candidate))) {
    return build("the commit contains an ambiguous path", changedPaths);
  }
  const webRelevant = changedPaths.filter((candidate) => !isNonWebPath(candidate));
  if (webRelevant.length > 0) {
    return build(`web-relevant paths changed: ${webRelevant.join(", ")}`, changedPaths);
  }
  return skip("all changed paths are outside the production web application", changedPaths);
}

export function decisionForCommit({
  cwd = process.cwd(),
  commitSha = process.env.VERCEL_GIT_COMMIT_SHA,
} = {}) {
  const requestedSha = commitSha?.trim() ?? "";
  if (!requestedSha) {
    return build("VERCEL_GIT_COMMIT_SHA is unavailable (for example, a CLI deployment)");
  }
  if (!/^[0-9a-f]{40}$/i.test(requestedSha)) {
    return build("VERCEL_GIT_COMMIT_SHA is not a full Git SHA-1");
  }

  const resolved = runGit(cwd, ["rev-parse", "--verify", `${requestedSha}^{commit}`]);
  if (resolved.status !== 0 || resolved.error) {
    return build("the Vercel Git commit is not available in the checkout");
  }
  const canonicalSha = resolved.stdout.toString("ascii").trim().toLowerCase();
  if (canonicalSha !== requestedSha.toLowerCase()) {
    return build("the Vercel Git commit did not resolve exactly");
  }

  const ancestry = runGit(cwd, ["rev-list", "--parents", "-n", "1", canonicalSha]);
  if (ancestry.status !== 0 || ancestry.error) {
    return build("the commit ancestry is unavailable");
  }
  const commitAndParents = ancestry.stdout.toString("ascii").trim().split(/\s+/);
  if (commitAndParents.length !== 2 || commitAndParents[0] !== canonicalSha) {
    return build("root and merge commits always build");
  }
  const parentSha = commitAndParents[1];

  // Disabling rename detection is intentional. A move from src/ to desktop/
  // must include the deleted web path and therefore trigger a build.
  const changed = runGit(cwd, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    parentSha,
    canonicalSha,
    "--",
  ]);
  if (changed.status !== 0 || changed.error) {
    return build("the commit diff could not be read");
  }
  const rawPaths = changed.stdout.toString("utf8").split("\0");
  if (rawPaths.at(-1) === "") rawPaths.pop();
  return classifyChangedPaths(rawPaths);
}

function runAsIgnoreCommand() {
  const decision = decisionForCommit();
  const verb = decision.skip ? "skipped" : "required";
  console.log(`Vercel web build ${verb}: ${decision.reason}.`);
  if (decision.changedPaths.length > 0) {
    console.log(`Changed paths: ${decision.changedPaths.join(", ")}`);
  }

  // Vercel's ignoreCommand contract is inverted: zero skips the build and a
  // non-zero status proceeds. Every uncertain state above deliberately builds.
  process.exitCode = decision.skip ? 0 : 1;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runAsIgnoreCommand();
