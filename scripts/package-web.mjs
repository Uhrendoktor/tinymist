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
const webExtensionBytes = await fs.readFile(path.join(vscodeDir, "out/extension.web.js"));
const assetLock = JSON.parse(
  await fs.readFile(path.join(root, "target", "wasm-assets", "wasm-assets.lock.json"), "utf8"),
);
async function listBundledFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }
  await visit(directory);
  return files;
}
const packageAssetsRoot = path.join(root, "target", "wasm-assets", "packages");
const packageFiles = await listBundledFiles(packageAssetsRoot);
const fontFiles = await listBundledFiles(path.join(root, "target", "wasm-assets", "fonts"));

// wasm-opt may split, merge, or rewrite data segments, so a package file's
// original bytes are not guaranteed to remain contiguous in the optimized
// module. The Rust build script emits every file as an include_bytes! entry
// keyed by its virtual path; the browser VFS resolves through that static
// lookup table. Verify every key survives optimization, and separately check
// raw bytes for font data where the embedded font resolver has no path index.
for (const assetPath of packageFiles) {
  const relativePath = path.relative(packageAssetsRoot, assetPath).split(path.sep).join("/");
  const embeddedPath = Buffer.from(`/tinymist-wasm-assets/packages/${relativePath}`);
  const assetBytes = await fs.readFile(assetPath);
  assert.ok(assetBytes.length > 0, `Bundled package file is empty: ${relativePath}`);
  assert.ok(
    wasmBytes.includes(embeddedPath),
    `WASM module is missing the embedded package file index entry: ${relativePath}`,
  );
}

const fontAssetsRoot = path.join(root, "target", "wasm-assets", "fonts");
for (const assetPath of fontFiles) {
  const relativePath = path.relative(fontAssetsRoot, assetPath).split(path.sep).join("/");
  const embeddedPath = Buffer.from(`/tinymist-wasm-assets/fonts/${relativePath}`);
  const assetBytes = await fs.readFile(assetPath);
  assert.ok(assetBytes.length > 0, `Bundled font file is empty: ${relativePath}`);
  assert.ok(
    wasmBytes.includes(embeddedPath),
    `WASM module is missing the embedded font file index entry: ${relativePath}`,
  );
}
if (assetLock.packages.length > 0) {
  assert.ok(
    wasmBytes.includes(Buffer.from("/tinymist-wasm-assets/packages")),
    "WASM module is missing the embedded package registry prefix",
  );
}
for (const marker of ["tinymist-preview-frame", "browserTransport"]) {
  assert.ok(
    webExtensionBytes.includes(Buffer.from(marker)),
    `Web extension bundle does not contain browser preview bridge marker: ${marker}`,
  );
}
const embeddedPreviewHtml = await fs.readFile(
  path.join(root, "crates", "tinymist-assets", "src", "typst-preview.html"),
  "utf8",
);
for (const marker of [
  "tinymist-preview-document-ready",
  "tinymist-preview-frontend-ready",
  "preview-arg:state:",
  "typst-container",
]) {
  assert.ok(
    embeddedPreviewHtml.includes(marker),
    `Built preview HTML is missing required browser marker: ${marker}`,
  );
}
for (const method of [
  "tinymist/preview/clientMessage",
  "tinymist/preview/serverMessage",
]) {
  assert.ok(
    wasmBytes.includes(Buffer.from(method)),
    `WASM module is missing the browser preview LSP bridge method: ${method}`,
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

const noticesSource = path.join(root, "target", "wasm-assets", "THIRD-PARTY-NOTICES.txt");
const noticesTarget = path.join(stageDir, "out", "THIRD-PARTY-NOTICES.txt");
const noticesBytes = await fs.readFile(noticesSource);
assert.ok(
  wasmBytes.includes(noticesBytes),
  "WASM module does not contain the bundled third-party license notices",
);
await fs.copyFile(noticesSource, noticesTarget);
assert.ok(
  (await fs.readFile(noticesTarget, "utf8")).includes("Third-party assets bundled"),
  "VSIX must include third-party asset notices",
);

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

// Remove manifest-contributed commands that depend on native local servers or
// directory output. Their handlers are also not registered by the web entry.
const unavailableWebCommands = new Set([
  "typst-preview.browser",
  "typst-preview.browser-slide",
  "typst-preview.eject",
]);
if (stagedManifest.contributes) {
  if (Array.isArray(stagedManifest.contributes.commands)) {
    stagedManifest.contributes.commands = stagedManifest.contributes.commands.filter(
      (command) => !unavailableWebCommands.has(command.command),
    );
  }
  if (Array.isArray(stagedManifest.contributes.keybindings)) {
    stagedManifest.contributes.keybindings = stagedManifest.contributes.keybindings.filter(
      (binding) => !unavailableWebCommands.has(binding.command),
    );
  }
  if (stagedManifest.contributes.menus) {
    for (const entries of Object.values(stagedManifest.contributes.menus)) {
      if (Array.isArray(entries)) {
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (unavailableWebCommands.has(entries[index].command)) {
            entries.splice(index, 1);
          }
        }
      }
    }
  }
}

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
assert.ok(
  archiveEntries.includes("extension/out/THIRD-PARTY-NOTICES.txt"),
  "VSIX is missing third-party asset notices",
);

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
