
// dist/tinymist/rs
#import "mod.typ": *

#let title = if is-md-target {
  "Tinymist"
} else {
  "Introduction"
}

#show: book-page.with(title: title)

#if is-md-target {
  let image(src, alt: none) = html.elem("img", attrs: (src: src, alt: alt))
  link(
    "https://github.com/Uhrendoktor/tinymist/blob/main/LICENSE",
    image("https://img.shields.io/github/license/Uhrendoktor/tinymist", alt: "GitHub license"),
  )
  link("https://github.com/Uhrendoktor/tinymist/actions/workflows/ci.yml", image(
    "https://github.com/Uhrendoktor/tinymist/actions/workflows/ci.yml/badge.svg?event=push",
    alt: "Actions status",
  ))
  link("https://myriad-dreamin.github.io/tinymist/", image(
    "https://img.shields.io/badge/view-documentation-blue",
    alt: "Documentation",
  ))
  link("https://deepwiki.com/Myriad-Dreamin/tinymist", image(
    "https://deepwiki.com/badge.svg",
    alt: "Ask DeepWiki",
  ))
}

Tinymist [ˈtaɪni mɪst] is an integrated language service for #link("https://typst.app/")[Typst] [taɪpst]. You can also call it #ruby[微][wēi][霭][ǎi] in Chinese.

= About this fork

This repository is a standalone, maintained fork of #link("https://github.com/Myriad-Dreamin/tinymist")[upstream Tinymist]. Its main branch is kept up to date by bringing upstream changes into this fork while retaining the fork-specific work described here.

The browser and WebAssembly packaging and asset-bundling capability is owned and maintained exclusively in this fork. This includes the Typst package/font wasm-assets.toml manifest, its checksum lock file, bundled Typst packages and fonts, and the local scripts/build-browser.mjs builder for browser VSIX files.

This fork is not an upstream contribution branch. Do not merge this fork's main branch or its WASM-specific feature branches back into Myriad-Dreamin/tinymist, and do not submit fork-only WASM changes as upstream pull requests. Upstream changes flow into this fork; the WASM bundling capability is maintained here.

= Standalone browser/WASM build

== Why this library exists

The browser build is designed to be a standalone Typst compiler package for environments where a normal extension cannot download packages or fonts at runtime. This is useful for locked-down company machines, restricted networks, and offline workstations.

The Typst packages and extra fonts you select are downloaded at build time, checked, and embedded into the WebAssembly (WASM) binary inside the VSIX. When the extension is running, it resolves those packages and fonts from the embedded bundle. It does not contact the Typst package registry, download fonts, or need operating-system font discovery. A package that was not bundled is reported as missing instead of being fetched from the network.

The compiler runs inside the browser's WebAssembly sandbox. The WASM module has no ambient network access and no unrestricted operating-system filesystem access: it cannot open arbitrary files, scan folders, or make network requests by itself. To compile a document, the VS Code extension host reads the workspace inputs that the editor makes available and explicitly passes the required content to the WASM compiler through the extension API bridge. That is a controlled input channel, not direct filesystem access from WASM.

This boundary limits what the compiler module can access; it is not a claim that every document or extension is automatically safe. The compiler still processes document content supplied to it, and the surrounding VS Code/browser installation should be kept up to date.

For a locked-down deployment, build the VSIX on a trusted machine, transfer the finished VSIX to the target machine, and install it locally. Package and font resolution for the assets embedded in that VSIX does not require runtime network access.

== Customize bundled packages and fonts

The default package list is in `wasm-assets.toml`. Start by copying it:

```sh
cp wasm-assets.toml my-wasm-assets.toml
```

Edit the `[packages]` table in `my-wasm-assets.toml`. Keys are the actual Typst package names; no aliases or Cargo version prefixes are needed. Use a single version string, a list of versions, or `"latest"`:

```toml
[packages]
cetz = ["0.3.4", "0.5.3"]
zero = ["0.6.1", "0.7.1"]
codly = "2.0.0"
fletcher = "latest"
```

Typst imports still require a concrete version. When you run `--update-lock`, `"latest"` is resolved against the Typst Universe index and the selected version is recorded in the lock. Normal locked builds keep using that selected version until you deliberately update the lock.

You can also bundle a package directly from a local directory or Git repository:

```toml
[packages]
my_local_package = { path = "../my-local-package", namespace = "local" }
my_git_package = { git = "https://github.com/example/typst-package.git", rev = "0123456789abcdef0123456789abcdef01234567", subdirectory = "package", namespace = "local" }
```

A local path is relative to the manifest file and must contain the package's `typst.toml`. For Git sources, specify exactly one of `rev`, `tag`, or `branch`; the lock records the resolved commit. A full commit ID in `rev` is the most explicit choice. Use arrays to select multiple local or Git versions of the same package too.

For published Typst packages, do not add per-package license tables: the builder reads the SPDX expression from `typst.toml` and the `LICENSE` file from the package source. It retrieves canonical SPDX texts when `LICENSE` is only a short identifier. Package license details are stored in the lock. Use `[package.metadata.tinymist.dependency-metadata.<package-name>]` only for exceptional overrides.

Typst's built-in text fonts are compiled into the web build and need no configuration. Add extra fonts under `[package.metadata.tinymist.fonts.<name>]`. Each extra font needs a file URL and explicit license information; only bundle fonts whose licenses permit redistribution.

For example, add an extra font like this (merge it into the copied manifest):

```toml
[package.metadata.tinymist.fonts.MyFontRegular]
file = "MyFont-Regular.ttf"
url = "https://example.org/fonts/MyFont-Regular.ttf"
license = "SIL OFL 1.1"
license-url = "https://example.org/fonts/OFL.txt"
```

For a non-standard package without a discoverable license notice, provide an explicit license override under `[package.metadata.tinymist.dependency-metadata.<package-name>]`. The package and font names/URLs above are placeholders. Package sources, versions, checksums and license notice hashes are recorded in the adjacent lock file.

Each manifest has a neighbouring `.lock.json` file. It records SHA-256 hashes for registry package archives or deterministic local/Git package contents, downloaded font files, and license notices. When you first use a custom manifest, or change its dependencies or fonts, generate/update that lock as part of the build with `--update-lock`. Keep the TOML file and its lock file together. For normal repeat builds, leave off `--update-lock` so the recorded checksums are enforced.

== Build a browser VSIX

Clone this fork and enter the repository:

```sh
git clone https://github.com/Uhrendoktor/tinymist.git
cd tinymist
```

Build with the default package/font list:

```sh
node scripts/build-browser.mjs
```

Or build your custom manifest and choose the VSIX output path:

```sh
node scripts/build-browser.mjs \
  --manifest "$PWD/my-wasm-assets.toml" \
  --output "$PWD/dist/tinymist-web-custom.vsix" \
  --update-lock
```

Use `--update-lock` on the first build after changing the manifest. For later reproducible builds, run the same command without that flag. The script installs the repository's pinned JavaScript dependencies, makes sure the WASM Rust target is installed, builds the browser extension, and prints the resulting VSIX path and SHA-256 checksum.

You need Node.js 20.11 or newer (Node.js 24 is used in CI), Rust and `rustup`, npm, and the usual native build tools. On Linux x86_64 and macOS/other POSIX systems, the script bootstraps the pinned Yarn and `wasm-pack` tools. On Windows, install Yarn 1.22.22 and `wasm-pack` 0.15.1 yourself and put them on `PATH`.

The custom manifest can be stored outside the repository too. The full configuration reference, lock-file commands, host prerequisites, and runtime limitations are in the #link("docs/wasm-browser-assets.md")[browser WASM asset guide].

== Install the VSIX in Visual Studio Code

Copy the generated `.vsix` file to the computer where you want to use the extension. You do not need to install it from the Marketplace.

1. Open Visual Studio Code.
2. Open the Extensions view with `Ctrl+Shift+X` (Windows/Linux) or `Cmd+Shift+X` (macOS).
3. Select the `...` menu in the Extensions view and choose Install from VSIX.... You can also open the Command Palette and run Extensions: Install from VSIX....
4. Select the VSIX you built, for example `dist/tinymist-web-custom.vsix`.
5. Reload or restart VS Code if it asks you to.

You can also install it from a terminal when the `code` command is on your `PATH`:

```sh
code --install-extension ./dist/tinymist-web-custom.vsix
```

After installation, open a `.typ` file or a Typst workspace to use the extension. For more information about VS Code's local VSIX installation, see the #link("https://code.visualstudio.com/docs/configure/extensions/extension-marketplace")[official VS Code documentation].

It contains:
- an analyzing library for Typst, see #github-link("/crates/tinymist-query/")[tinymist-query].
- a CLI for Typst, see #github-link("/crates/tinymist/")[tinymist].
  - which provides a language server for Typst, see #cross-link("/feature/language.typ")[Language Features].
  - which provides a preview server for Typst, see #cross-link("/feature/preview.typ")[Preview Feature].
- a VSCode extension for Typst, see #github-link("/editors/vscode/")[Tinymist VSCode Extension].

= Features

#include "feature/language-content.typ"

= Versioning and Release Cycle

#include "versioning.typ"

The release cycle is as follows:
- If there is a typst version update, a new major or minor version will be released intermediately. This means tinymist will always align the minor version with typst.
- If there is at least a bug or feature added this week, a new patch version will be released.

= Installation

Follow the instructions to enable tinymist in your favorite editor.
- #cross-link("/frontend/vscode.typ")[VS Cod(e,ium)]
- #cross-link("/frontend/neovim.typ")[Neovim]
- #cross-link("/frontend/emacs.typ")[Emacs]
- #cross-link("/frontend/sublime-text.typ")[Sublime Text]
- #cross-link("/frontend/helix.typ")[Helix]
- #cross-link("/frontend/zed.typ")[Zed]

= Installing Regular/Nightly Prebuilds from GitHub

Note: if you don't know what is a regular/nightly release, please don't follow this section.

Besides published releases specific to each editor, you can also download the latest regular/nightly prebuilts from GitHub and install them manually.

- Regular prebuilts can be found in #link("https://github.com/Myriad-Dreamin/tinymist/releases")[GitHub Releases].
- Nightly prebuilts can be found in #link("https://github.com/Myriad-Dreamin/tinymist/actions")[GitHub Actions].
  - (Suggested) Use the #link("https://github.com/hongjr03/tinymist-nightly-installer")[tinymist-nightly-installer] to install the nightly prebuilts automatically.
    - Unix (Bash):
      ```bash
      curl -sSL https://github.com/hongjr03/tinymist-nightly-installer/releases/latest/download/run.sh | bash
      ```
    - Windows (PowerShell):
      ```bash
      iwr https://github.com/hongjr03/tinymist-nightly-installer/releases/latest/download/run.ps1 -UseBasicParsing | iex
      ```
  - The prebuilts for other revisions can also be found manually. For example, if you are seeking a nightly release for the featured #link("https://github.com/Myriad-Dreamin/tinymist/pull/468")[PR: build: bump version to 0.11.17-rc1], you could click and go to the #link("https://github.com/Myriad-Dreamin/tinymist/actions/runs/10120639466")[action page] run for the related commits and download the artifacts.

To install extension file (the file with `.vsix` extension) manually, please #kbd("Ctrl+Shift+X") in the editor window and drop the downloaded vsix file into the opened extensions view.

= Documentation

See #link("https://myriad-dreamin.github.io/tinymist/")[Online Documentation].

= Packaging

#let channel-img(lnk, img) = if sys-is-html-target {
  html.elem("a", attrs: (
    href: lnk,
    target: "_blank",
    rel: "noopener noreferrer",
  ))[
    #html.elem("img", attrs: (src: img, alt: "Packaging status", style: "max-width: 100%; height: auto;"))
  ]
} else {
  link(lnk)
}

Stable Channel:

#channel-img(
  "https://repology.org/project/tinymist/versions",
  "https://repology.org/badge/vertical-allrepos/tinymist.svg",
)

Nightly Channel:

#channel-img(
  "https://repology.org/project/tinymist-nightly/versions",
  "https://repology.org/badge/vertical-allrepos/tinymist-nightly.svg",
)

= Roadmap

== Short Terms

To encourage contributions, we create many #link("https://github.com/Myriad-Dreamin/tinymist/pulls")[Pull Requests] in draft to navigate short-term plans. They give you a hint of what or where to start in this large repository.

== Long Terms

We are planning to implement the following features in typst v0.14.0 or spare time in weekend:

- Type checking: Complete the type checker.
- Periscope renderer: Disabled since vscode rejects to render SVGs containing foreignObjects.
- Inlay hints: Disabled _by default_ because of performance issues.
- Find references of dictionary fields and named function arguments.
- Improve symbol view's appearance.
- Improve package view.
  - Navigate to symbols by clicking on the symbol name in the view.
  - Automatically locate the symbol item in the view when viewing local documentation.
  - Remember the recently invoked package commands, e.g. "Open Docs of \@preview/cetz:0.3.1", "Open directory of \@preview/touying:0.5.3".
- Improve label view.
  - Group labels.
  - Search labels.
  - Keep (persist) group preferences.
- Improve Typst Preview.
  - Pin drop-down: Set the file to preview in the drop-down for clients that doesn't support passing arguments to the preview command.
  - Render in web worker (another thread) to reduce overhead on the electron's main thread.
- #strike[Spell checking: There is already a branch but no suitable (default) spell checking library is found.]
  - #link("https://github.com/crate-ci/typos")[typos] is great for typst. #link("https://github.com/Automattic/harper")[harper] looks promise.

If you are interested in any of the above features, please feel free to send Issues to discuss or PRs to implement to #link("https://github.com/Myriad-Dreamin/tinymist")[GitHub.]

= Contributing

Please read the #link("CONTRIBUTING.md")[CONTRIBUTING.md] file for contribution guidelines.

= Sponsoring

Tinymist thrives on community love and remains proudly independent. While we don't accept direct project funding, we warmly welcome support for our maintainers' personal efforts. Please go to #github-link("/MAINTAINERS.md")[Maintainers Page] and #link("https://github.com/Myriad-Dreamin/tinymist/graphs/contributors")[Contributors Page] and find their personal pages for more information. It is also welcomed to directly ask questions about sponsoring on the #link("https://github.com/Myriad-Dreamin/tinymist/issues/new")[GitHub Issues].

= Acknowledgements

- Part of the code is inherited from #link("https://github.com/nvarner/typst-lsp")[typst-lsp]
- The #github-link("/editors/vscode#symbol-view")[integrating] *offline* handwritten-stroke recognizer is powered by #link("https://detypify.quarticcat.com/")[Detypify].
- The #github-link("/editors/vscode#preview-command")[integrating] preview service is powered by #link("https://github.com/Enter-tainer/typst-preview")[typst-preview].
- The #github-link("/editors/vscode#managing-local-packages")[integrating] local package management functions are adopted from #link("https://github.com/OrangeX4/vscode-typst-sync")[vscode-typst-sync].
