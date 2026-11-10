import assert from "node:assert/strict";
import test from "node:test";

import { parseAssetManifestText } from "./wasm-assets-manifest.mjs";

test("parses Cargo aliases and optional package license overrides", async () => {
  const manifest = await parseAssetManifestText(
    `
[package]
name = "custom-browser-assets"
version = "0.1.0"
publish = false

[package.metadata.tinymist]
schema-version = 1

[dependencies]
cetz_0_3_4 = { package = "cetz", version = "=0.3.4" }
cetz_0_5_3 = { package = "cetz", version = "=0.5.3" }
oxifmt = "=1.0.0"

[package.metadata.tinymist.limits]
max-total-bytes = 1000000
max-package-bytes = 500000
max-font-bytes = 250000

[package.metadata.tinymist.dependency-metadata.oxifmt]
license = "MIT OR Apache-2.0"
license-file = "LICENSES/NOTICE"
license-url = "https://example.invalid/oxifmt/LICENSE"

[package.metadata.tinymist.fonts.ExampleFont]
file = "ExampleFont-Regular.ttf"
url = "https://example.invalid/ExampleFont-Regular.ttf"
license = "SIL OFL 1.1"
license-url = "https://example.invalid/OFL.txt"
`,
    ".toml",
  );

  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(manifest.limits, {
    maxTotalBytes: 1000000,
    maxPackageBytes: 500000,
    maxFontBytes: 250000,
  });
  assert.deepEqual(
    manifest.packages.map(({ namespace, name, version, license }) => ({
      namespace,
      name,
      version,
      license,
    })),
    [
      { namespace: "preview", name: "cetz", version: "0.3.4", license: undefined },
      { namespace: "preview", name: "cetz", version: "0.5.3", license: undefined },
      { namespace: "preview", name: "oxifmt", version: "1.0.0", license: "MIT OR Apache-2.0" },
    ],
  );
  assert.equal(manifest.packages[2].licenseFile, "LICENSES/NOTICE");
  assert.equal(manifest.packages[2].licenseUrl, "https://example.invalid/oxifmt/LICENSE");
  assert.deepEqual(manifest.fonts, [
    {
      name: "ExampleFont",
      file: "ExampleFont-Regular.ttf",
      url: "https://example.invalid/ExampleFont-Regular.ttf",
      license: "SIL OFL 1.1",
      licenseUrl: "https://example.invalid/OFL.txt",
    },
  ]);
});

test("rejects non-exact Cargo version requirements", async () => {
  await assert.rejects(
    parseAssetManifestText(
      `
[package]
name = "custom-browser-assets"
version = "0.1.0"

[dependencies]
cetz = "0.5.3"

[package.metadata.tinymist.dependency-metadata.cetz]
license = "MIT"
license-url = "https://example.invalid/LICENSE"
`,
      ".toml",
    ),
    /pinned exactly/,
  );
});

test("continues to read legacy JSON manifests during migration", async () => {
  const manifest = await parseAssetManifestText(
    JSON.stringify({
      schemaVersion: 1,
      packages: [{ namespace: "preview", name: "cetz", version: "0.5.3" }],
      fonts: [],
    }),
    ".json",
  );
  assert.equal(manifest.packages[0].version, "0.5.3");
});
