# Browser WASM assets: external Typst packages and fonts

The browser VSIX can carry a curated set of Typst packages and extra fonts without
requiring a runtime connection or a native executable. GitHub Actions downloads
these assets while building the extension; Rust build scripts then use
include_bytes! to place package files and font bytes into tinymist_bg.wasm.
The resulting VSIX can compile those documents with the network disabled and
without permission to execute native files.

## Add assets

Edit wasm-assets.json. Package versions must be exact; use full versions for
@preview imports. Package entries accept an optional archive URL; when omitted,
the official Typst package archive URL is derived from namespace, name, and
version. Fonts must be TTF, OTF, or TTC files. Each asset must declare its
redistribution license and a URL serving the license text. The asset archive
and font bytes are pinned by SHA-256 in the adjacent lock file.

Example entries (insert into the default manifest arrays):

```json
{
  "packages": [
    {
      "namespace": "preview",
      "name": "cetz",
      "version": "0.4.2",
      "license": "MIT",
      "licenseUrl": "https://example.invalid/cetz/LICENSE"
    }
  ],
  "fonts": [
    {
      "name": "Example Font Regular",
      "file": "ExampleFont-Regular.ttf",
      "url": "https://example.invalid/fonts/ExampleFont-Regular.ttf",
      "license": "SIL OFL 1.1",
      "licenseUrl": "https://example.invalid/fonts/OFL.txt"
    }
  ]
}
```

The example package version and font URL are illustrative; verify current
availability and redistribution terms before adding them. Do not add a font
unless its license permits redistribution in an embedded application.

## Lock and build

To download assets on a trusted machine or in GitHub Actions and generate/update
the lock:

```sh
node scripts/bundle-wasm-assets.mjs --manifest wasm-assets.json --update-lock
```

Review and commit both wasm-assets.json and wasm-assets.lock.json.
Normal browser builds use --locked, download the assets again, verify every
SHA-256, and fail on any manifest/lock mismatch.

The WASM: custom browser package workflow accepts a manifest path and an
update_lock switch. Run it with update_lock=true to produce a new lock,
then commit the generated lock before making a reproducible build. Run it with
update_lock=false for a strict locked build. The workflow uploads the VSIX,
the generated lock snapshot, and third-party notices. For a non-default manifest,
copy the uploaded snapshot to the matching adjacent lock path (for example,
custom-assets.lock.json next to custom-assets.json) and commit it before running
a locked build.

## Runtime boundary

- Package archives are unpacked during the GitHub build, then each package file
  is statically embedded in the WASM module. The browser package registry maps
  only manifest-listed namespace/name/version tuples to those in-module paths.
- The package access model serves embedded package files before consulting the
  normal VS Code workspace filesystem adapter. Workspace files still use
  vscode.workspace.fs.
- Font bytes are registered in the browser font resolver from the same WASM
  static bundle. No OS font enumeration, font download, or browser font upload
  is needed at runtime for these bundled fonts.
- The browser's JS package resolver remains a fail-closed fallback. A package
  not in the build manifest returns NotFound; it is never downloaded at runtime.
- The packager adds THIRD-PARTY-NOTICES.txt to the VSIX. The package and font
  payload bytes themselves are compiled into tinymist_bg.wasm, not left as
  executable sidecar assets.

Package imports are scanned in extracted .typ files. If a bundled package
imports another versioned package not listed in the manifest, asset bundling
fails and names the missing dependency. Add that exact version explicitly.
