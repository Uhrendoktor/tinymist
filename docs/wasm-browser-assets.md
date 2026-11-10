# Browser WASM assets: packages and fonts

The browser VSIX can bundle Typst packages and extra licensed fonts directly
into its WebAssembly module. The browser runtime never downloads packages or
fonts and has no ambient filesystem or network access.

## Package manifest

The `[packages]` table is intentionally keyed by the actual Typst package
name. There are no dependency aliases and no Cargo-style `=` prefix.

Use a plain version for one published version, an array for several versions,
or `"latest"` when the newest published version should be selected on the next
lock update:

```toml
[packages]
cetz = ["0.3.4", "0.5.3"]
zero = ["0.6.1", "0.7.1"]
codly = "2.0.0"
fletcher = "latest"
```

Typst imports still need an exact version. Accordingly, `latest` is a
build-time selector: `--update-lock` queries the Typst Universe package index,
selects the highest published version and records that concrete version and
archive checksum. Normal locked builds reuse that version from the lock and do
not re-resolve `latest`. Run `--update-lock` deliberately when you want to
refresh it.

### Local package directories

Use `path` for a package already on disk. Paths are resolved relative to the
manifest file. The source directory must contain the package's `typst.toml`
and the files it needs:

```toml
[packages]
my-local-package = { path = "../my-local-package", namespace = "local" }
```

The package's name and version are read from `typst.toml`. For local sources,
the bundler copies regular files into the build, excludes the `.git`
directory, rejects symlinks, and records a deterministic content hash in the
lock. Use `namespace = "preview"` when the package is imported from
`@preview`; `local` is convenient for packages imported from `@local`.

You can select more than one local version in the same package entry by using
an array of source tables:

```toml
[packages]
my-local-package = [
  { path = "../my-local-package-1", namespace = "local" },
  { path = "../my-local-package-2", namespace = "local" },
]
```

### Git repositories

Use `git` with exactly one of `rev`, `tag`, or `branch`. The optional
`subdirectory` selects a package below the repository root. For fully
reproducible configuration, prefer a full commit ID in `rev`:

```toml
[packages]
my-git-package = {
  git = "https://github.com/example/typst-package.git",
  rev = "0123456789abcdef0123456789abcdef01234567",
  subdirectory = "packages/my-git-package",
  namespace = "local",
}
```

Tags and branches are also accepted. When the lock is updated, the bundler
resolves the selected ref to a commit ID and records it. Locked builds fetch
that commit, rather than following a moving branch or tag. Multiple versions
or sources of the same package can be combined in an array:

```toml
[packages]
my-git-package = [
  "1.0.0",
  { git = "https://github.com/example/typst-package.git", tag = "v2.0.0" },
]
```

### Package licenses

For published Typst Universe packages, **you do not need to declare a license
or license URL for every dependency**. The bundler reads the SPDX expression
from the package's `typst.toml` and uses the `LICENSE` file from the same
archive. If that file is only an SPDX pointer (for example,
`MIT OR Apache-2.0`), the bundler retrieves the canonical license texts for
each identifier.

The resolved expression, notice sources, and SHA-256 checksums are written to
the lock. The same automatic license discovery is used for local and Git
sources when they contain a normal Typst package manifest and `LICENSE` file.

Use `[package.metadata.tinymist.dependency-metadata.<package-name>]` only for
exceptional packages that need a custom namespace/archive URL, an explicit
license override, or a non-standard license notice source. The package name
itself does not imply a license.

## Extra fonts

Typst's built-in fonts are compiled into the web build by the
`tinymist-project/web` Cargo feature. They require no manifest entry. Add a
`[package.metadata.tinymist.fonts.<name>]` table only for fonts outside that
built-in set. Unlike Typst packages, a font file has no standard
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
application. Use the actual font download URL and license text for your font.

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
self-hosted runner. Rust/rustup, Node.js 20.11 or newer (Node.js 24 is used in
CI), npm, and the usual native build tools must be installed.

The output argument is optional. Without it, the VSIX is written to the normal
`dist/tinymist-web-<version>.vsix` path.

## Locks and reproducible builds

Each manifest has an adjacent `.lock.json` file. Generate or update it on a
trusted machine:

```sh
node scripts/build-browser.mjs \
  --manifest /absolute/path/to/my-wasm-assets.toml \
  --output ./dist/tinymist-web-custom.vsix \
  --update-lock
```

The lock records each package source digest (the downloaded archive for
registry packages, or a deterministic directory-content hash for local and
Git packages), the license expression read from `typst.toml`, each notice
source, and the SHA-256 digest of every notice text. This includes texts retrieved from the SPDX License List when a
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
