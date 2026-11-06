# Full browser-hosted Tinymist (WebAssembly)

## Goal

Provide a browser-only VS Code extension package that runs Tinymist without launching any native executable, while retaining the existing Tinymist language server and preview implementation wherever the browser platform permits it.

This is deliberately not a second Typst renderer and not a replacement for Tinymist's lazy preview. The existing `tinymist-preview` actor/data-plane should remain the rendering authority.

## Why the current WebAssembly extension is incomplete

Tinymist already has a WASM language-server entry point (`crates/tinymist/src/web.rs`) and a VS Code browser entry point (`editors/vscode/src/extension.web.ts`). The browser entry point intentionally advertises a reduced feature set: preview, export, tasks, package, tool, testing, and several editor integrations are disabled. Therefore, shipping the WASM module alone does not enable the full desktop feature set.

The native preview command currently creates a local HTTP server and WebSocket endpoint (`crates/tinymist/src/tool/preview/http.rs`). That transport depends on TCP sockets and Hyper's server APIs, which are unavailable to a browser WebWorker extension. The preview renderer itself is more reusable: `tinymist-preview` exposes a generic Sink/Stream data plane and already implements incremental/partial rendering. The missing piece is a browser-compatible transport between the Rust worker and the VS Code Webview.

Other native assumptions also need browser adapters:
- filesystem access must go through `vscode.workspace.fs` and the existing client-side file synchronization;
- curated package and font assets can be supplied by a build-time manifest and embedded in WASM; runtime package downloads and OS font discovery remain unavailable;
- workspace/user font provisioning still requires a separate browser-safe source if it is to be supported;
- export must return bytes to the extension host and write them through VS Code's workspace filesystem;
- native tasks, shell/process launch, local HTTP serving, and external-browser opening require browser-specific equivalents or explicit unsupported states.

Finally, a no-native desktop install must select the browser extension host. VS Code selects the Node extension host when a package supplies both a `main` and a `browser` entry and Node is available. A browser-only VSIX must use the `browser` entry without a native `main` entry; otherwise VS Code can still try to start the native executable.

## Proposed architecture

1. Build the existing Tinymist crate for `wasm32-unknown-unknown` with its `web` feature. Keep the LSP server, project model, diagnostics, completion, formatting, navigation, semantic tokens, and other in-process language features in the worker.
2. Keep the native extension package unchanged. Produce a separate browser-only VSIX with a browser entry point and no native `main` entry.
3. Split preview core from native transport dependencies. Compile the existing preview actors/data-plane for WASM and adapt its Sink/Stream to task-scoped LSP notifications and VS Code Webview messages. Do not reimplement rendering in TypeScript or render every page eagerly.
4. Reuse the current preview frontend and its binary incremental-render protocol. The Webview adapter should preserve page navigation, outline, scroll synchronization, source-to-preview navigation, and partial rendering.
5. Keep browser workspace access on `vscode.workspace.fs`; supply offline packages/fonts through the build-time asset manifest and embed their bytes in WASM. Keep OS-dependent features gated behind the native/system feature.
6. Add browser-target build and CI checks, strict package/font hash-lock and license checks, WASM-byte embedding assertions, and integration tests for multi-page lazy preview.

## Tokio and WASM constraints

The current preview crate enables Tokio's `rt-multi-thread` feature. The `wasm32-unknown-unknown` target does not support Tokio's multi-thread runtime feature; browser builds need a current-thread runtime and target-specific feature selection. Browser builds also cannot use native filesystem, thread, TCP listener, process, or shell APIs.

## Scope and compatibility

The intended result is feature parity for editor/LSP and the integrated preview, plus browser-backed export/package/font capabilities where the required adapters are available. Native-only facilities such as launching external programs, serving localhost HTTP, opening an external browser, and arbitrary shell tasks cannot be made available merely by compiling the same Rust code to WASM; they need alternatives or must remain explicitly native-only.

## Validation required before release

- `cargo check` for the native workspace and the WASM feature combination;
- browser extension TypeScript build and Webview frontend build;
- VSIX inspection proving the browser package has no native executable entry point;
- WebExtension-host activation test proving no native binary is spawned;
- multi-page integration test exercising page selection, lazy page rendering, incremental updates, outline, and scroll/source synchronization;
- export, package resolution, workspace-font, and large-document performance tests.

## Current implementation status (2026-11-06)

The branch now has a browser-only VSIX packager, a dedicated browser Worker build, and an archive check that removes the Node `main` entry and native executable payloads. It also contains the preview feature split (`preview-core`, `preview`, `preview-web`), target-specific Tokio runtime features, and shared Typst preview renderer dependencies on WASM.

The browser preview bridge is implemented in source: the Rust data plane serializes the existing `WsMessage` protocol to task-scoped LSP notifications; the VS Code extension forwards those frames to the preview Webview; and the frontend adapts its WebSocket API to the VS Code message channel. The web extension enables this preview path and its lifecycle cleanup. Browser export is also enabled: the WASM build includes the `export` feature, requests export bytes in memory, and writes them through `vscode.workspace.fs`.

Frame conversion tests cover text, binary, ping, pong, and invalid base64. A focused Vitest test also verifies that browser mode always selects the bundled previewer while native mode preserves configured previewers.

The browser build now rebuilds `tools/typst-preview-frontend` before compiling the WASM asset, and checks for the bridge markers in both generated HTML and the resulting WASM module. The WebSocket shim is gated to browser Webviews, and browser preview startup no longer asks Rust to create a localhost listener. These checks are committed but remain unexecuted until an exact-head workflow run is available.

**Browser asset scope (2026-11-06):** the WASM extension renders with the preview HTML compiled into Tinymist's own WASM asset and the existing incremental renderer. It ignores configured custom preview providers, does not load external preview HTML or third-party previewer extensions, and does not use localhost HTTP/WebSocket services. External Typst packages and fonts are available only when listed in `wasm-assets.json`; GitHub Actions fetches them, checks the adjacent SHA-256 lockfile and license notices, and compiles their bytes into `tinymist_bg.wasm`. The browser package registry fails closed for every unlisted package; runtime downloads are not used. Workspace/user font injection and OS font discovery remain unsupported.

Before this PR can be called verified, exact-head CI must build/package the browser VSIX and verify selected package/font/license bytes are embedded in WASM; a live VS Code Web Extension Host test must cover multi-page rendering, incremental updates after edits, outline/source/scroll synchronization, and disposal. Native-only tasks/process launch, shell commands, TCP servers, OS font enumeration, and external application launching remain unsupported.