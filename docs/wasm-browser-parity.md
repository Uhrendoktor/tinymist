# Browser-only Tinymist: WASM parity plan

## Objective

Provide a Tinymist VS Code extension build that runs the language server and document preview entirely in the VS Code browser extension host. The package must not contain or select a native Tinymist executable. Preserve the existing Tinymist compiler, LSP handlers, preview renderer, incremental page updates, outline generation, source navigation, and viewport synchronization wherever the browser host can support them.

This is an extension of Tinymist's existing WebAssembly implementation. It is not a second Typst implementation and it is not a replacement preview renderer.

## Why the current web build is incomplete

The repository already has a real WASM language server:

- `crates/tinymist/src/web.rs` exports `TinymistLanguageServer` through wasm-bindgen and runs the normal `LspBuilder` on a current-thread Tokio runtime.
- `editors/vscode/src/lsp.web.ts` starts a browser Worker and connects it through `vscode-languageclient/browser`.
- `editors/vscode/src/web/server.ts` instantiates `tinymist_bg.wasm` and bridges LSP messages between the Worker and the extension client.
- The web LSP registers the same Rust request handlers as the regular server for core editing functionality.

The missing capabilities are deliberate feature omissions and native transport assumptions, not a limitation in Typst's ability to compile or render in WASM:

1. **The browser entry point turns off major UI features.** `extension.web.ts` sets `preview`, `export`, `task`, `package`, `tool`, `label`, `language`, and other feature flags to false, and its browser activation table is empty. Shared activation also disables preview, drag/drop, copy/paste, on-enter, and render-docs for every web host.
2. **The extension package still selects Node on desktop.** `editors/vscode/package.json` declares both `main` and `browser`. VS Code chooses the Node extension host on desktop when both entry points are available. Bundling WASM into that package therefore does not provide a reliable no-executable fallback. A browser-only distribution must omit `main` and must not ship `out/tinymist` or `out/tinymist.exe`.
3. **The Rust preview feature is currently a native server feature.** `crates/tinymist/src/tool/preview.rs` imports Hyper/Tungstenite and starts a `tokio::net::TcpListener` in `tool/preview/http.rs`. The VS Code preview client expects a local HTTP server and WebSocket port. Browser extension workers cannot create arbitrary listening TCP sockets.
4. **The preview crate's Tokio dependency requests the multi-thread runtime.** `crates/typst-preview/Cargo.toml` unconditionally enables `rt-multi-thread`; the browser WASM target only supports Tokio's single-thread runtime subset. The existing WASM language server already uses a current-thread runtime.
5. **The existing preview engine is reusable.** `crates/typst-preview/src/lib.rs` owns the render/editor/webview actors and its data-plane accepts generic Sink/Stream connections. Partial rendering and incremental page updates are implemented there. The native-only part is the HTTP/WebSocket adapter and lifecycle wrapper around it.
6. **Browser filesystem, package, and font services are partial.** The VS Code web LSP already syncs files from `vscode.workspace.fs`, but the browser package registry has an empty package index and no local package/cache paths, and the browser font searcher currently loads embedded fonts unless explicit web fonts are supplied. There is no native system-font enumeration or arbitrary native filesystem access in the browser.
7. **Export and tasks have not been wired through the browser UX.** Rust contains export handlers and Typst rendering libraries, but the web feature table does not register the related VS Code commands. Browser exports must return bytes/data to the extension host and persist them using `vscode.workspace.fs.writeFile`, rather than relying on native paths, shells, or external applications.

## Proposed implementation

### A. Ship an explicitly browser-only VSIX

- Add a dedicated packaging command that stages the compiled web extension, deletes the `main` manifest property, sets a distinct browser distribution identity, and packages only the browser bundles, WASM module, preview frontend, syntax assets, icons, and localization files.
- Assert that the staged manifest has a `browser` entry and no `main` entry.
- Assert that no native `tinymist` executable is present in the staged package.
- Keep the current platform-specific VSIX and Node entry point unchanged. The browser-only artifact is an additional installable build.

### B. Separate renderer features from native preview transport

- Split the Cargo feature that enables the preview model/actors from the optional native Hyper server dependencies.
- Add a browser preview feature that compiles the same `tinymist-preview` actors without enabling Hyper, TCP listeners, or native process APIs.
- Make Tokio's `rt-multi-thread` feature target-specific. Browser builds use `rt`, `sync`, and `time` with the existing current-thread runtime.
- Keep the existing native preview adapter behind a native/system cfg; do not regress the native server.

### C. Add a message-port preview data plane

- Introduce a browser transport that adapts the existing `WsMessage` data plane to task-scoped LSP notifications and VS Code Webview messages.
- Connect the extension host to the WASM Worker and the VS Code Webview through a scoped, per-preview channel. The webview must not attempt to reach localhost or expose a listening port.
- Keep the existing preview protocol and actors. In particular, preserve initial full state, incremental diff frames, partial-rendering negotiation, outline messages, source-to-document jumps, document-to-source jumps, scroll synchronization, viewer window state, multiple preview task IDs, and disposal.
- Authenticate/associate every bridge with its preview task ID; close ports and stop actors when a panel is disposed. Do not accept arbitrary messages from unrelated webviews.

### D. Complete browser workspace services

- Use VS Code's workspace filesystem API for source reads, imports, package caches and generated outputs. Continue using the existing watched-file synchronization for files that change outside open text documents.
- Implement browser package-index discovery and package-cache storage through a JS host adapter (IndexedDB or the VS Code global storage URI). Preserve Typst package version semantics and avoid silently mapping a package to the wrong version.
- Add an explicit font-loading path for workspace/user-provided fonts. Keep embedded fonts as the deterministic fallback. System font discovery should be documented as unavailable unless a browser-safe font enumeration API exists.

### E. Enable features incrementally and by capability

- Turn on preview only after the browser LSP notification tunnel and Webview bridge are implemented; retain a draft/release gate until the runtime path is integration-tested.
- Turn on export only after binary responses can be written through VS Code's workspace filesystem; do not enable task runners or process-backed commands that still require child processes.
- Re-enable web-compatible UI (outline, labels, package docs, symbol tools, language features) individually after removing Node-only imports and supplying browser equivalents.
- Keep native-only operations (shell/process invocation, opening files with external applications, OS font enumeration, native file watchers, TCP services, and process-backed debugging) disabled or provide an explicit browser implementation. Do not advertise them as supported merely because the WASM crate compiles.

### F. Validate the browser distribution in CI

- Build the Rust WASM server with the browser preview and export feature combination.
- Build the web extension bundles and browser-only VSIX.
- Inspect the packaged VSIX manifest and file list to ensure no `main` entry or native executable is present.
- Run existing Rust and VS Code tests plus targeted transport/protocol tests. Add an end-to-end test for multiple pages and for incremental updates after editing a source file.
- Keep all native build and packaging workflows working.

## Acceptance criteria

- A browser-only VSIX can be installed into desktop VS Code and runs in the Web Worker extension host without probing, downloading, or executing a native binary.
- Core LSP behavior (diagnostics, completion, formatting, semantic tokens, navigation, hover, symbols, code actions, inlay hints, and rename) continues to work.
- The integrated preview displays every page through Tinymist's existing lazy/incremental renderer. It does not eagerly materialize every page as a separate SVG and does not introduce Megamist's page-zero-only behavior.
- Editing a source document updates only the necessary preview content, while outline, source navigation, and scroll synchronization remain functional.
- Preview disposal stops its renderer actors and closes all message ports without leaking background work.
- Browser-safe export writes files via VS Code's filesystem API.
- Missing platform services are explicit and their UI stays disabled until implemented.
- The standard native VSIX remains unchanged and its CI checks continue to pass.

## Scope and honest platform boundary

"Full WASM Tinymist" means full Typst language tooling, editor integration, preview, and browser-compatible export/workspace services without any native executable. It does not mean that browser WebAssembly can reproduce arbitrary OS APIs. Child processes, shell tools, native TCP listeners, arbitrary host filesystem access, direct OS font enumeration, and native application launching need browser-specific alternatives and must not be presented as available without those alternatives.

## Implementation tracking

This document records the intended architecture and acceptance boundary. Individual checkboxes should be updated only after the corresponding implementation and CI evidence exists.


## Current branch milestone (2026-11-06)

The current branch milestone now includes:

- A second esbuild entry for `src/web/server.ts`, producing `out/web-server.js` and bundling the wasm-bindgen module into the Worker.
- A separately staged browser VSIX. Its manifest has `browser` but no `main`; it removes npm runtime dependencies and native executable/debug files. The packager verifies the VSIX archive contents.
- A CI job to build the browser WASM/VSIX artifact, plus a push trigger for `wasm/**` branches.
- Cargo feature boundaries for `preview-core`, `preview`, and `preview-web`. Browser preview uses the existing render/editor/outline actors without the native Hyper/TCP server dependencies.
- Tokio's `rt-multi-thread` enabled only on non-WASM targets. The preview crate requests `rt`, `sync`, and `time` for the single-threaded browser runtime; shared renderer dependencies are available on WASM too.
- A task-scoped browser preview data plane. Rust adapts the preview actor's existing `WsMessage` stream to `tinymist/preview/serverMessage` and routes client frames from `tinymist/preview/clientMessage` back to the matching preview task.
- A VS Code Webview bridge that preserves the existing preview frontend's WebSocket-shaped API and binary incremental-render protocol. The browser preview commands and lifecycle/disposal path are enabled in the web extension.
- Browser export commands enabled in the web extension. Export bytes are requested in memory and persisted through `vscode.workspace.fs` rather than a native file writer.
- Unit tests for text, binary, ping, and pong frame round-trips and malformed base64 rejection.

**Still outstanding:** the browser registry resolver deliberately returns no package path; `JsRegistry::packages()` and local package/cache paths are empty. The browser font searcher currently uses embedded fonts and its web-font loading API is not wired to a VS Code/browser font provider. The preview bridge has not yet been proven in a running VS Code Web Extension Host with multi-page rendering, incremental updates, outline/source/scroll synchronization, or disposal. The browser VSIX build job is defined, but this branch has no confirmed exact-head Actions result yet. Keep this PR in draft until those package/font adapters and runtime checks are complete.
