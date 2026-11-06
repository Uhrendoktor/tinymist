import { build } from "esbuild";
import { polyfillNode } from "esbuild-plugin-polyfill-node";
import * as fs from "fs";

const target = ["es2020", "chrome61", "edge18", "firefox60"];

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
    // wasm-bindgen's synchronous initializer accepts the bytes. Keeping the
    // module in the worker bundle also avoids a second network/file lookup.
    loader: {
      ".wasm": "binary",
    },
  }),
]);
