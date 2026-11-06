import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const vscodeDir = path.join(root, "editors", "vscode");
const stageDir = path.join(root, "target", "tinymist-vscode-web-package");
const outputDir = path.join(root, "dist");

const sourceManifest = JSON.parse(
  await fs.readFile(path.join(vscodeDir, "package.json"), "utf8"),
);
const version = sourceManifest.version;
const outputPath = path.join(outputDir, `tinymist-web-${version}.vsix`);

const requiredFiles = [
  "out/extension.web.js",
  "out/web-server.js",
  "out/tinymist_bg.wasm",
];

for (const relativePath of requiredFiles) {
  await fs.access(path.join(vscodeDir, relativePath)).catch(() => {
    throw new Error(
      `Missing browser build output: editors/vscode/${relativePath}. Run yarn build:vscode:web first.`,
    );
  });
}

const wasmBytes = await fs.readFile(path.join(vscodeDir, "out/tinymist_bg.wasm"));
for (const marker of ["tinymist-preview-frame", "browserTransport"]) {
  assert.ok(
    wasmBytes.includes(Buffer.from(marker)),
    `WASM module does not contain bundled preview bridge marker: ${marker}`,
  );
}

await fs.rm(stageDir, { recursive: true, force: true });
await fs.mkdir(stageDir, { recursive: true });
await fs.cp(vscodeDir, stageDir, {
  recursive: true,
  filter(source) {
    const relative = path.relative(vscodeDir, source);
    if (!relative) return true;

    const parts = relative.split(path.sep);
    if (
      parts.some((part) =>
        [".git", "node_modules", ".vscode-test", "test-dist", "coverage"].includes(part),
      )
    ) {
      return false;
    }

    if (
      [
        "out/extension.js",
        "out/tinymist",
        "out/tinymist.exe",
        "out/tinymist.pdb",
      ].includes(relative)
    ) {
      return false;
    }

    return true;
  },
});

const stagedManifestPath = path.join(stageDir, "package.json");
const stagedManifest = JSON.parse(await fs.readFile(stagedManifestPath, "utf8"));

// A browser-only package must force VS Code to select the Web Worker host,
// including on desktop installations where the Node host is also available.
delete stagedManifest.main;
stagedManifest.displayName = "Tinymist Typst (WebAssembly)";

// The web entry point is bundled. It must not install Node-only dependencies
// or the local wasm-pack workspace link as extension runtime dependencies.
delete stagedManifest.dependencies;
delete stagedManifest.devDependencies;
delete stagedManifest.scripts;

assert.ok(stagedManifest.browser, "browser entry point must be present");
assert.equal(stagedManifest.main, undefined, "browser-only package must not declare main");

await fs.writeFile(
  stagedManifestPath,
  `${JSON.stringify(stagedManifest, null, 2)}\n`,
);

// Remove any native payloads that may have been left over by a previous
// platform build in the shared editors/vscode/out directory.
for (const relativePath of [
  "out/extension.js",
  "out/tinymist",
  "out/tinymist.exe",
  "out/tinymist.pdb",
]) {
  await fs.rm(path.join(stageDir, relativePath), { force: true });
}

await fs.mkdir(outputDir, { recursive: true });
await fs.rm(outputPath, { force: true });

const vsceCandidates = [
  path.join(root, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce"),
  path.join(vscodeDir, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce"),
];
let vscePath;
for (const candidate of vsceCandidates) {
  try {
    await fs.access(candidate);
    vscePath = candidate;
    break;
  } catch {
    // Check the next workspace installation location.
  }
}

if (!vscePath) {
  throw new Error(
    "Could not locate the installed @vscode/vsce executable. Run yarn install before packaging.",
  );
}

execFileSync(vscePath, ["package", "--no-dependencies", "--out", outputPath], {
  cwd: stageDir,
  stdio: "inherit",
});

const archiveEntries = execFileSync("unzip", ["-Z1", outputPath], {
  encoding: "utf8",
}).split("\n");
const archiveManifest = JSON.parse(
  execFileSync("unzip", ["-p", outputPath, "extension/package.json"], {
    encoding: "utf8",
  }),
);

assert.ok(archiveManifest.browser, "VSIX must include a browser entry point");
assert.equal(archiveManifest.main, undefined, "VSIX must not include a Node main entry");
for (const relativePath of requiredFiles) {
  assert.ok(
    archiveEntries.includes(`extension/${relativePath}`),
    `VSIX is missing ${relativePath}`,
  );
}

const nativePayloads = archiveEntries.filter((entry) =>
  /^extension\/out\/(tinymist(\.exe|\.pdb)?|extension\.js)$/.test(entry),
);
assert.deepEqual(
  nativePayloads,
  [],
  `browser-only VSIX contains native/Node payloads: ${nativePayloads.join(", ")}`,
);

console.log(`Verified browser-only VSIX: ${outputPath}`);
console.log("Manifest: browser entry present; main entry absent.");
console.log("Payload: WASM worker included; native Tinymist executable absent.");
