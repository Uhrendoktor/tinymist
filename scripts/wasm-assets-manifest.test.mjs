import assert from "node:assert/strict";
import test from "node:test";

import { parseAssetManifestText } from "./wasm-assets-manifest.mjs";

test("parses packages by their actual names, one version or multiple versions", async () => {
  const manifest = await parseAssetManifestText(
    `
[package]
name = "custom-browser-assets"
version = "0.1.0"
publish = false

[package.metadata.tinymist]
schema-version = 2

[packages]
cetz = ["0.3.4", "0.5.3"]
codly = "2.0.0"
fletcher = "latest"

[package.metadata.tinymist.limits]
max-total-bytes = 1000000
max-package-bytes = 500000
max-font-bytes = 250000

[package.metadata.tinymist.fonts.ExampleFont]
file = "ExampleFont-Regular.ttf"
url = "https://example.invalid/ExampleFont-Regular.ttf"
license = "SIL OFL 1.1"
license-url = "https://example.invalid/OFL.txt"
`,
    ".toml",
  );

  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.limits, {
    maxTotalBytes: 1000000,
    maxPackageBytes: 500000,
    maxFontBytes: 250000,
  });
  assert.deepEqual(
    manifest.packages.map(({ namespace, name, versionSpec, source }) => ({
      namespace, name, versionSpec, source,
    })),
    [
      { namespace: "preview", name: "cetz", versionSpec: "0.3.4", source: { type: "registry" } },
      { namespace: "preview", name: "cetz", versionSpec: "0.5.3", source: { type: "registry" } },
      { namespace: "preview", name: "codly", versionSpec: "2.0.0", source: { type: "registry" } },
      { namespace: "preview", name: "fletcher", versionSpec: "latest", source: { type: "registry" } },
    ],
  );
  assert.equal(manifest.packages[0].manifestKey, "preview/cetz@0.3.4");
  assert.equal(manifest.packages[1].manifestKey, "preview/cetz@0.5.3");
  assert.equal(manifest.fonts[0].name, "ExampleFont");
});

test("parses local package paths and Git sources with rev, tag or branch", async () => {
  const manifest = await parseAssetManifestText(
    `
[package]
name = "source-fixtures"
version = "0.1.0"

[packages]
local_pkg = { path = "../local-pkg", namespace = "local" }
github_pkg = { git = "https://github.com/example/typst-pkg.git", rev = "0123456789abcdef0123456789abcdef01234567", subdirectory = "pkg", namespace = "local" }
tag_pkg = { git = "https://github.com/example/other.git", tag = "v1.2.3" }
branch_pkg = { git = "https://github.com/example/third.git", branch = "main" }
`,
    ".toml",
  );

  assert.deepEqual(manifest.packages.map((item) => item.source), [
    { type: "path", path: "../local-pkg" },
    {
      type: "git",
      git: "https://github.com/example/typst-pkg.git",
      refType: "rev",
      ref: "0123456789abcdef0123456789abcdef01234567",
      subdirectory: "pkg",
    },
    {
      type: "git",
      git: "https://github.com/example/other.git",
      refType: "tag",
      ref: "v1.2.3",
      subdirectory: ".",
    },
    {
      type: "git",
      git: "https://github.com/example/third.git",
      refType: "branch",
      ref: "main",
      subdirectory: ".",
    },
  ]);
  assert.equal(manifest.packages[0].namespace, "local");
  assert.equal(manifest.packages[1].manifestKey, "local/github_pkg@git:https://github.com/example/typst-pkg.git#rev:0123456789abcdef0123456789abcdef01234567:pkg");
});

test("rejects invalid version and ambiguous Git source declarations", async () => {
  await assert.rejects(
    parseAssetManifestText(
      `
[package]
name = "invalid"
version = "0.1.0"

[packages]
cetz = "0.5"
`,
      ".toml",
    ),
    /full version/,
  );
  await assert.rejects(
    parseAssetManifestText(
      `
[package]
name = "invalid"
version = "0.1.0"

[packages]
pkg = { git = "https://github.com/example/pkg.git" }
`,
      ".toml",
    ),
    /exactly one of rev, tag, or branch/,
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
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.packages[0].versionSpec, "0.5.3");
  assert.equal(manifest.packages[0].manifestKey, "preview/cetz@0.5.3");
});
