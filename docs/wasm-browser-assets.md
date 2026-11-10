# Browser WASM assets: packages and fonts

The browser VSIX can bundle Typst packages and extra licensed fonts directly
into its WebAssembly module. The browser runtime never downloads packages or
fonts and has no ambient filesystem or network access.

## Dependency manifest

Use `wasm-assets.toml`, which uses the familiar Cargo.toml layout. Package
versions are exact Cargo requirements (the leading `=` is intentional).
Normal Cargo dependency aliases let you include multiple versions of the same
Typst package.

For normal Typst Universe packages, **you do not need to declare a license or
license URL for every dependency**. The bundler reads the package's own
`typst.toml` file and obtains the `[package].license` SPDX expression. It
also takes the package's `LICENSE` file from the same downloaded archive. If
that file contains only a short SPDX expression (for example,
`MIT OR Apache-2.0`), the bundler retrieves the corresponding canonical
license texts from the SPDX License List. The resolved expression, notice
sources, and SHA-256 checksums are written into the lock file.

A normal manifest can therefore be as small as:

```toml
[package]
name = "tinymist-browser-assets"
version = "0.1.0"
edition = "2021"
publish = false

[dependencies]
cetz = "=0.5.3"
cetz_0_3_4 = { package = "cetz", version = "=0.3.4" }
oxifmt = "=1.0.0"

[package.metadata.tinymist.limits]
max-total-bytes = 157286400
max-package-bytes = 67108864
max-font-bytes = 33554432
```

The package namespace defaults to `preview`. If you use a package from another
namespace, or a custom archive URL, set only those exceptional details:

```toml
[package.metadata.tinymist.dependency-metadata.my_local_package]
namespace = "local"
url = "https://example.org/packages/my-local-package-1.2.3.tar.gz"
```

A non-registry package normally should also contain a `typst.toml` manifest
with a `[package].license` SPDX expression and a `LICENSE` file. For an
exceptional package that does not provide those standard files, you can
explicitly override the license metadata:

```toml
[package.metadata.tinymist.dependency-metadata.my_local_package]
license = "MIT"
license-file = "LICENSES/NOTICE"
# Or provide an HTTPS URL when the notice is not present in the archive:
# license-url = "https://example.org/my-local-package/LICENSE"
```

Do not add per-package metadata tables unless you actually need an override.
The package name itself does **not** imply a license; the declaration comes
from the package manifest and the bundled notice is taken from the archive or
an SPDX canonical text.

## Extra fonts

The Typst built-in text fonts are already included by the
`tinymist-project/web` Cargo feature. Add a
`[package.metadata.tinymist.fonts.<name>]` table only for additional fonts
you need. Unlike Typst packages, a font file does not have a standard
`typst.toml` manifest, so its redistribution license and notice source still
need to be supplied explicitly.

```toml
[package.metadata.tinymist.fonts.ExampleFontRegular]
file = "ExampleFont-Regular.ttf"
url = "https://example.org/fonts/ExampleFont-Regular.ttf"
license = "SIL OFL 1.1"
license-url = "https://example.org/fonts/OFL.txt"
```

Only bundle fonts whose licenses permit redistribution in an embedded
application. The example names and URLs are illustrative; use the actual
font download URL and license text for your font.

## Build locally (no fork or GitHub Actions required)

Clone the public repository, prepare a TOML manifest with your dependencies,
then run the browser build script:

```sh
git clone https://github.com/Uhrendoktor/tinymist.git
cd tinymist
node scripts/build-browser.mjs \\
  --manifest /absolute/path/to/my-wasm-assets.toml \\
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
node scripts/build-browser.mjs \\
  --manifest /absolute/path/to/my-wasm-assets.toml \\
  --output ./dist/tinymist-web-custom.vsix \\
  --update-lock
```

The lock records the exact package archive digest, the license expression
read from `typst.toml`, each notice source, and the SHA-256 digest of every
notice text. This includes texts retrieved from the SPDX License List when a
package's `LICENSE` file is only an SPDX pointer. Font bytes and font license
notices are locked in the same way. Review and retain both your TOML manifest
and its generated lock file.

Use `--update-lock` after changing packages, versions, fonts, or explicit
license overrides. For ordinary repeat builds, omit that flag: locked mode
verifies the downloaded package/font bytes and license notices against the
committed lock. An unexpected change fails the build instead of silently
changing the bundled notices.

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

**License metadata is not a legal audit.** Typst's package manifest supplies
the package author's declared SPDX expression, not proof that every file or
third-party asset in the archive is covered by that same license. Review the
package README and licensing notes for file-level exceptions before
redistributing a bundle. If a package uses different licenses for different
files, or has a custom `LicenseRef`, provide and review an explicit override.
