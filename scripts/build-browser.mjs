#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");

function usage() {
  console.log([
    "Usage: node scripts/build-browser.mjs [options]",
    "",
    "Build a browser-only Tinymist VSIX locally, without GitHub Actions or a fork.",
    "",
    "Options:",
    "  --manifest <path>  Cargo-style TOML asset manifest (default: wasm-assets.toml)",
    "  --output <path>    Destination VSIX path (default: dist/tinymist-web-<version>.vsix)",
    "  --update-lock      Regenerate the manifest's adjacent SHA-256 lock before building",
    "  --help             Show this help",
  ].join("\n"));
}

function parseArgs(argv) {
  const args = {
    manifest: path.join(root, "wasm-assets.toml"),
    output: undefined,
    updateLock: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--manifest" || arg === "--output") {
      const value = argv[++i];
      if (!value) throw new Error(arg + " requires a path");
      args[arg === "--manifest" ? "manifest" : "output"] = path.resolve(process.cwd(), value);
    } else if (arg === "--update-lock") {
      args.updateLock = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  return args;
}

function run(command, argv, options = {}) {
  console.log("\n>", command, ...argv);
  const result = spawnSync(command, argv, {
    cwd: root,
    env: options.env ?? process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(command + " failed with exit code " + (result.status ?? "unknown"));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (Number(process.versions.node.split(".")[0]) < 20) {
    throw new Error("Node.js 20 or newer is required (Node.js 24 is used in CI).");
  }
  await fs.access(args.manifest);
  if (!/\.toml$/i.test(args.manifest) && !/\.json$/i.test(args.manifest)) {
    throw new Error("The asset manifest must be a .toml or .json file.");
  }

  const env = { ...process.env };
  const toolsRoot = env.TINYMIST_TOOLS_DIR || path.join(os.homedir(), ".cache", "tinymist-tools");
  const yarnBin = path.join(toolsRoot, "yarn", "1.22.22", "node_modules", ".bin");
  const wasmPackHome = path.join(toolsRoot, "wasm-pack", "0.15.1");

  if (process.platform !== "win32") {
    run("bash", ["scripts/ensure-wasm-tools.sh"], { env });
  } else {
    console.warn(
      "Windows: install Yarn 1.22.22 and wasm-pack 0.15.1 yourself; the automatic tool bootstrap is POSIX-only.",
    );
  }

  env.PATH = [yarnBin, wasmPackHome, env.PATH || ""].join(path.delimiter);

  const installedTargets = spawnSync("rustup", ["target", "list", "--installed"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (installedTargets.error) throw installedTargets.error;
  if (installedTargets.status !== 0) {
    throw new Error("rustup is required to install the wasm32-unknown-unknown target.");
  }
  if (!installedTargets.stdout.split(/\r?\n/).includes("wasm32-unknown-unknown")) {
    run("rustup", ["target", "add", "wasm32-unknown-unknown"], { env });
  }

  env.TINYMIST_WASM_ASSET_MANIFEST = args.manifest;
  env.TINYMIST_WASM_ASSET_UPDATE_LOCK = args.updateLock ? "true" : "false";

  // Install the repository's pinned JS build dependencies. This is incremental
  // and does not modify yarn.lock.
  run("yarn", ["install", "--frozen-lockfile", "--prefer-offline"], { env });
  run("yarn", ["package:vscode:web"], { env });

  const vscodePackage = JSON.parse(
    await fs.readFile(path.join(root, "editors", "vscode", "package.json"), "utf8"),
  );
  const version = vscodePackage.version;
  const builtVsix = path.join(root, "dist", "tinymist-web-" + version + ".vsix");
  await fs.access(builtVsix);

  const output = args.output ? args.output : builtVsix;
  if (path.resolve(output) !== path.resolve(builtVsix)) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(builtVsix, output);
  }

  const bytes = await fs.readFile(output);
  const digest = createHash("sha256").update(bytes).digest("hex");
  console.log("\nBrowser-only Tinymist build complete.");
  console.log("VSIX: " + output);
  console.log("Size: " + bytes.length + " bytes");
  console.log("SHA-256: " + digest);
}

main().catch((error) => {
  console.error("\nBrowser build failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
