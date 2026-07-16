import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? path.join(desktopRoot, "dist", "desktop.sbom.cdx.json"));
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const listed = spawnSync(command, ["list", "--depth", "Infinity", "--json"], {
  cwd: desktopRoot,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
if (listed.status !== 0) {
  console.error(`generate-sbom: pnpm list failed\n${listed.stderr}`);
  process.exit(1);
}

const roots = JSON.parse(listed.stdout);
const packageJson = JSON.parse(await readFile(path.join(desktopRoot, "package.json"), "utf8"));
const components = new Map();
const relationships = new Map();

function cleanVersion(value) {
  const match = String(value ?? "").match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0] ?? "unknown";
}

function ref(name, version) {
  return `pkg:npm/${encodeURIComponent(name).replace("%40", "@") }@${encodeURIComponent(version)}`;
}

function walk(name, node) {
  const version = cleanVersion(node?.version);
  const bomRef = ref(name, version);
  if (!components.has(bomRef)) {
    components.set(bomRef, {
      type: "library",
      name,
      version,
      "bom-ref": bomRef,
      purl: bomRef,
    });
  }
  const children = Object.entries(node?.dependencies ?? {}).map(([childName, child]) => {
    walk(childName, child);
    return ref(childName, cleanVersion(child?.version));
  });
  relationships.set(bomRef, [...new Set(children)].sort());
}

const root = roots[0] ?? {};
for (const [name, node] of Object.entries(root.dependencies ?? {})) walk(name, node);
for (const [name, node] of Object.entries(root.devDependencies ?? {})) walk(name, node);

const appRef = `pkg:npm/${packageJson.name}@${packageJson.version}`;
const direct = [
  ...Object.keys(root.dependencies ?? {}).map((name) => ref(name, cleanVersion(root.dependencies[name]?.version))),
  ...Object.keys(root.devDependencies ?? {}).map((name) => ref(name, cleanVersion(root.devDependencies[name]?.version))),
];
relationships.set(appRef, [...new Set(direct)].sort());

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: packageJson.name,
      version: packageJson.version,
      "bom-ref": appRef,
    },
  },
  components: [...components.values()].sort((left, right) =>
    left["bom-ref"].localeCompare(right["bom-ref"]),
  ),
  dependencies: [...relationships.entries()]
    .map(([dependencyRef, dependsOn]) => ({ ref: dependencyRef, dependsOn }))
    .sort((left, right) => left.ref.localeCompare(right.ref)),
};

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(bom, null, 2) + "\n", "utf8");
console.log(`generate-sbom: wrote ${bom.components.length} components to ${output}`);
