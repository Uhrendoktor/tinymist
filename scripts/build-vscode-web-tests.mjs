import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const extensionRoot = path.join(root, "target", "tinymist-vscode-web-package");
const output = path.join(extensionRoot, "out", "web-test-runner.js");

await fs.access(path.join(extensionRoot, "package.json"));
await fs.mkdir(path.dirname(output), { recursive: true });

await build({
  entryPoints: [path.join(root, "editors", "vscode", "src", "test", "web", "runTests.ts")],
  outfile: output,
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "browser",
  target: ["es2022"],
});

console.log(`Built VS Code Web integration runner: ${output}`);
