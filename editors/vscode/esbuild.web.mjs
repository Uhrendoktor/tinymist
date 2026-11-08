import { build } from "esbuild";
import { polyfillNode } from "esbuild-plugin-polyfill-node";
import * as fs from "fs";

const target = ["es2022"];

if (!fs.existsSync("./out/extension.js")) {
  fs.mkdirSync("./out", { recursive: true });
  fs.writeFileSync("./out/extension.js", "");
}

await Promise.all([
  build({
    entryPoints: ["./src/extension.web.ts"],
    bundle: true,
    outfile: "./out/extension.web.js",
    external: ["vscode"],
    format: "cjs",
    target,
    // Node.js global to browser globalThis.
    define: {
      global: "globalThis",
    },
    plugins: [
      polyfillNode({
        polyfills: {
          crypto: "empty",
        },
      }),
    ],
  }),
  // The language server runs in a dedicated Web Worker. Bundle it separately
  // from the extension host entry point so VS Code can start the worker by URL.
  build({
    entryPoints: ["./src/web/server.ts"],
    bundle: true,
    outfile: "./out/web-server.js",
    external: ["vscode"],
    format: "iife",
    platform: "browser",
    target,
    define: {
      global: "globalThis",
    },
    // Emit WASM as a separate asset rather than inlining a large binary into
    // web-server.js. The worker's async initializer fetches it relative to itself.
    loader: {
      ".wasm": "file",
    },
    assetNames: "[name]",
  }),
]);
