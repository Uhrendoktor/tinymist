# Browser WASM assets: packages and fonts

The browser VSIX can bundle Typst packages and extra licensed fonts directly
into its WebAssembly module. The browser runtime never downloads packages or
fonts and has no ambient filesystem or network access.

## Dependency manifest

Use `wasm-assets.toml`, which uses the familiar Cargo.toml layout. Package
versions are exact Cargo requirements (the leading `=` is intentional).
Normal Cargo dependency aliases let you include multiple versions of the same
Typst package.

The actual dependencies stay valid Cargo declarations. Typst-specific details
that Cargo does not understand—namespace, license and optional archive URL—are
stored under `[package.metadata.tinymist.dependency-metadata.<alias>]`.

For example:

```toml
[package]
name = "tinymist-browser-assets"
version = "0.1.0"
edition = "2021"
publish = false

[dependencies]
cetz_0_3_4 = { package = "cetz", version = "=0.3.4" }
cetz_0_5_3 = { package = "cetz", version = "=0.5.3" }

[package.metadata.tinymist.dependency-metadata.cetz_0_3_4]
namespace = "preview"
license = "MIT"
license-url = "https://example.invalid/cetz/LICENSE"

[package.metadata.tinymist.dependency-metadata.cetz_0_5_3]
namespace = "preview"
license = "MIT"
license-url = "https://example.invalid/cetz/LICENSE"

[package.metadata.tinymist.limits]
max-total-bytes = 157286400
max-package-bytes = 67108864
max-font-bytes = 33554432

[package.metadata.tinymist.fonts.ExampleFontRegular]
file = "ExampleFont-Regular.ttf"
url = "https://example.invalid/fonts/ExampleFont-Regular.ttf"
license = "SIL OFL 1.1"
license-url = "https://example.invalid/fonts/OFL.txt"
```

The example versions and URLs are illustrative. Verify package availability and
redistribution rights before adding assets. Do not bundle a font unless its
license permits redistribution in an embedded application.

The default manifest contains 27 pinned Typst package versions. The Typst
built-in text fonts are already included by the `tinymist-project/web` Cargo
feature; add a `[package.metadata.tinymist.fonts.<name>]` table only for
additional fonts you need.

## Build locally (no fork or GitHub Actions required)

Clone the public repository, prepare a TOML manifest with your dependencies,
then run the browser build script:

```sh
git clone https://github.com/Uhrendoktor/tinymist.git
cd tinymist
node scripts/build-browser.mjs \
  --manifest /absolute/path/to/my-wasm-assets.toml \
  --output ./dist/tinymist-web-custom.vsix
```

On Linux x86_64 the script installs SHA-256-verified pinned Yarn and
wasm-pack tools into your user cache. On macOS and other POSIX host
architectures it installs Yarn and builds the pinned wasm-pack release with
Cargo. On Windows, install Yarn 1.22.22 and wasm-pack 0.15.1 yourself and make
both available on PATH; the script checks those exact versions before building.

The script installs the repository's JavaScript dependencies, adds the
`wasm32-unknown-unknown` Rust target if it is missing, and builds/packages the
browser VSIX. It does not need a fork, GitHub token, workflow dispatch, or
self-hosted runner. Rust/rustup, Node.js 24+, npm, and the usual native build
tools must be installed.

The output argument is optional. Without it, the VSIX is written to the normal
`dist/tinymist-web-<version>.vsix` path.

## Locks and reproducible builds

Each manifest has an adjacent `.lock.json` file. Generate or update it on a
trusted machine:

```sh
node scripts/bundle-wasm-assets.mjs \
  --manifest /absolute/path/to/my-wasm-assets.toml \
  --update-lock
```

Review and retain both your TOML manifest and its generated lock file. Normal
builds use locked mode: downloaded package archives, font bytes and license
notices are checked against SHA-256 digests. Missing or mismatched entries fail
the build. The local build helper accepts `--update-lock` when you explicitly
want to regenerate the lock and then build:

```sh
node scripts/build-browser.mjs --manifest ./wasm-assets.toml --update-lock
```

A custom manifest and its lock may live outside the repository. This is useful
for personal builds and CI systems that consume the public source without
maintaining a fork.

## Runtime boundary

- Package archives are unpacked during the build, then statically embedded in
  `tinymist_bg.wasm`. The browser registry maps only manifest-listed
  namespace/name/version tuples to embedded paths.
- A package not listed in the manifest returns `NotFound`; there is no remote
  or workspace-filesystem fallback for Typst package assets.
- Workspace source files are separate inputs supplied by the VS Code extension
  host through its workspace API bridge. The WASM module itself has no ambient
  filesystem or network capability.
- Additional font bytes are registered in the browser font resolver from the
  same static WASM bundle. There is no OS font enumeration or runtime download.
- Third-party license notices are compiled into the WASM module and also
  included as a human-readable VSIX file.
- The browser build omits external-browser preview and directory-based Typst
  Bundle export, which require host services unavailable in the browser WASM
  runtime. Integrated Webview preview and in-memory exports remain available.

The packager scans imported `.typ` files in bundled packages. If one imports a
versioned package not listed in the manifest, asset bundling fails and names the
missing dependency. Add that exact version under `[dependencies]`.
