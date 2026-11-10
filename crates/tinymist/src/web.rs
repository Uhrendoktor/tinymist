//! Tinymist Web APIs.

use std::future::Future;
use std::pin::Pin;
use std::sync::LazyLock;
use std::task::{Context, Poll};

use futures::future::MaybeDone;
use sync_ls::{
    internal_error, invalid_params, JsTransportSender, LsDriver, LspBuilder, LspClientRoot,
    LspMessage, RequestId, ResponseError,
};
use tinymist_project::CompileFontArgs;
use wasm_bindgen::prelude::*;

use crate::{RegularInit, ServerState, LONG_VERSION};

/// Gets the long version description of the library.
#[wasm_bindgen]
pub fn version() -> String {
    LONG_VERSION.clone()
}

/// Initialize the browser runtime before attaching the LSP transport. Keeping
/// this preflight separate makes worker-startup failures identify the runtime
/// stage rather than appearing as an opaque language-server constructor panic.
#[wasm_bindgen]
pub fn init_runtime() {
    let _ = &RUNTIMES.tokio_runtime;
}

/// TinymistLanguageServer implements the LSP protocol for Typst documents
/// in a WebAssembly environment
#[wasm_bindgen]
pub struct TinymistLanguageServer {
    /// The client root that strongly references the LSP client.
    _client: LspClientRoot,
    /// The mutable state of the server.
    state: LsDriver<LspMessage, RegularInit>,
    /// The next synthetic request id for the web bridge.
    next_request_id: i32,
}

#[wasm_bindgen]
impl TinymistLanguageServer {
    /// Creates a new language server.
    #[wasm_bindgen(constructor)]
    pub fn new(init_opts: JsValue) -> Result<Self, JsValue> {
        let sender = serde_wasm_bindgen::from_value::<JsTransportSender>(init_opts)
            .map_err(|err| JsValue::from_str(&format!("Failed to deserialize init opts: {err}")))?;

        std::panic::set_hook(Box::new(console_error_panic_hook::hook));

        let _client = LspClientRoot::new_js(RUNTIMES.tokio_runtime.handle().clone(), sender);
        // Starts logging
        let _ = crate::init_log(crate::InitLogOpts {
            verbose: true,
            filter: None,
            output: Some(_client.weak()),
        });
        let state = ServerState::install_lsp(LspBuilder::new(
            RegularInit {
                client: _client.weak().to_typed(),
                font_opts: CompileFontArgs::default(),
                exec_cmds: Vec::new(),
            },
            _client.weak(),
        ))
        .build();

        Ok(Self {
            _client,
            state,
            next_request_id: 1,
        })
    }

    /// Handles internal events.
    pub fn on_event(&mut self, event_id: u32) {
        {
            let _entered = RUNTIMES.tokio_runtime.handle().enter();
            self.state.on_server_event(event_id);
        }
        poll_tokio_background_tasks();
    }

    /// Handles incoming requests.
    pub fn on_request(&mut self, method: String, js_params: JsValue) -> JsValue {
        let params = serde_wasm_bindgen::from_value::<serde_json::Value>(js_params);
        let params = match params {
            Ok(p) => p,
            Err(err) => return lsp_err(invalid_params(err)),
        };
        if method == "tinymist/fsChange" {
            log::info!("[browser-fs-debug] WASM bridge dispatching tinymist/fsChange");
        }
        if method == "tinymist/fsChange" {
            log::info!(
                "[browser-fs-debug] WASM on_request received tinymist/fsChange params={params:?}"
            );
        }
        let is_preview_start = method == "workspace/executeCommand"
            && params.get("command").and_then(serde_json::Value::as_str)
                == Some("tinymist.doStartPreview");
        if is_preview_start {
            log::info!(
                "[browser-preview-debug] WASM bridge received preview start request args={:?}",
                params.get("arguments")
            );
        }

        let req_id = self.next_request_id();
        let result = {
            let _entered = RUNTIMES.tokio_runtime.handle().enter();
            self.state.on_lsp_request(&method, req_id, params)
        };

        if method == "tinymist/fsChange" {
            log::info!("[browser-fs-debug] on_request received fsChange handler result");
        }
        let response = match result {
            Ok(MaybeDone::Done(Ok(t))) => {
                if is_preview_start {
                    log::info!(
                        "[browser-preview-debug] preview start command completed synchronously: {t:?}"
                    );
                }
                lsp_serialize(&t)
            }
            Ok(MaybeDone::Done(Err(err))) => {
                if is_preview_start {
                    log::error!(
                        "[browser-preview-debug] preview start command failed synchronously: {err:?}"
                    );
                }
                lsp_err(err)
            }
            // tokio doesn't get scheduled anymore after returning to js world
            Ok(MaybeDone::Future(fut)) => {
                if is_preview_start {
                    log::info!(
                        "[browser-preview-debug] preview start command returned an async response future"
                    );
                }
                let future = TokioDrivenFuture::new(fut);
                wasm_bindgen_futures::future_to_promise(async move {
                    let result = future.await;
                    if is_preview_start {
                        log::info!(
                            "[browser-preview-debug] preview start async response completed successfully={}",
                            result.is_ok()
                        );
                    }
                    poll_tokio_background_tasks();
                    Ok(match result {
                        Ok(t) => lsp_serialize(&t),
                        Err(err) => lsp_err(err),
                    })
                })
                .into()
            }
            // match futures::executor::block_on(fut) {
            //     Ok(t) => lsp_serialize(&t),
            //     Err(err) => lsp_err(err),
            // },
            Ok(MaybeDone::Gone) => lsp_err(internal_error("response was weirdly gone")),
            Err(err) => {
                if is_preview_start {
                    log::error!(
                        "[browser-preview-debug] preview start request rejected before scheduling: {err:?}"
                    );
                }
                lsp_err(err)
            }
        };
        if method == "tinymist/fsChange" {
            log::info!(
                "[browser-fs-debug] on_request serialized fsChange response; before runtime poll"
            );
        }
        poll_tokio_background_tasks();
        if method == "tinymist/fsChange" {
            log::info!("[browser-fs-debug] on_request runtime poll returned for fsChange");
        }
        response
    }

    /// Handles incoming notifications.
    pub fn on_notification(&mut self, method: String, js_params: JsValue) {
        let params = serde_wasm_bindgen::from_value::<serde_json::Value>(js_params);
        let params = match params {
            Ok(p) => p,
            Err(err) => {
                log::error!("Failed to deserialize notification params: {err}");
                return;
            }
        };

        {
            let _entered = RUNTIMES.tokio_runtime.handle().enter();
            let err = self.state.on_notification(&method, params);
            if let Err(err) = err {
                log::error!("Failed to handle notification {method}: {err:?}");
            }
        }
        poll_tokio_background_tasks();
    }

    /// Handles incoming responses.
    pub fn on_response(&mut self, js_result: JsValue) {
        let result = serde_wasm_bindgen::from_value::<sync_ls::lsp::Response>(js_result);
        let resp = match result {
            Ok(r) => r,
            Err(err) => {
                log::error!("Failed to deserialize response: {err}");
                return;
            }
        };
        {
            let _entered = RUNTIMES.tokio_runtime.handle().enter();
            self.state.on_lsp_response(resp);
        }
        poll_tokio_background_tasks();
    }

    /// Drive background Tokio tasks from the browser worker event loop.
    ///
    /// WebAssembly workers have no native executor thread to keep a current-thread
    /// runtime alive between LSP callbacks. The worker schedules this bounded
    /// pump periodically so preview actors and rendering tasks keep progressing.
    pub fn poll_runtime(&mut self) {
        poll_tokio_background_tasks();
    }

    /// Get the version of the language server.
    pub fn version() -> String {
        env!("CARGO_PKG_VERSION").to_string()
    }
}

impl TinymistLanguageServer {
    fn next_request_id(&mut self) -> RequestId {
        let req_id = self.next_request_id;
        self.next_request_id = self.next_request_id.checked_add(1).unwrap_or(1);
        RequestId::from(req_id)
    }
}

/// The runtimes used by the application.
pub struct Runtimes {
    /// The tokio runtime.
    pub tokio_runtime: tokio::runtime::Runtime,
}

impl Default for Runtimes {
    fn default() -> Self {
        let mut builder = tokio::runtime::Builder::new_current_thread();

        // Browser workers have neither a Mio-backed I/O reactor nor a
        // usable std::time::Instant. Tokio's timer driver calls Instant::now()
        // during initialization, which traps on wasm32-unknown-unknown. Leave
        // both I/O and timers disabled; wasm-bindgen futures are driven by the
        // browser event loop. Native builds keep the full Tokio drivers.
        #[cfg(not(target_arch = "wasm32"))]
        builder.enable_all();

        let tokio_runtime = builder
            .build()
            .expect("failed to build the Tinymist Tokio runtime");

        Self { tokio_runtime }
    }
}

static RUNTIMES: LazyLock<Runtimes> = LazyLock::new(Runtimes::default);

/// Poll an LSP response future with the WASM Tokio runtime entered.
///
/// LSP response futures are normally polled by the browser's JavaScript event
/// loop. Entering the current-thread runtime for each poll allows them to call
/// `tokio::spawn`; polling the runtime after each pending result advances the
/// preview actors without requiring native threads or a timer/I/O driver.
struct TokioDrivenFuture<F> {
    future: Pin<Box<F>>,
}

impl<F> TokioDrivenFuture<F> {
    fn new(future: F) -> Self {
        Self {
            future: Box::pin(future),
        }
    }
}

impl<F: Future> Future for TokioDrivenFuture<F> {
    type Output = F::Output;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let result = {
            let _entered = RUNTIMES.tokio_runtime.handle().enter();
            this.future.as_mut().poll(cx)
        };

        poll_tokio_background_tasks();
        result
    }
}

/// Drive tasks spawned on the current-thread Tokio runtime from the browser worker.
///
/// Tokio's current-thread scheduler suspends background tasks whenever its
/// block_on call returns. Native Tinymist keeps the runtime continuously driven
/// by its executor; the WebAssembly worker instead gives queued Tokio tasks a
/// bounded poll after each JavaScript/LSP callback. This keeps preview actors
/// and their data plane responsive without enabling unavailable I/O or timers.
fn poll_tokio_background_tasks() {
    #[cfg(target_arch = "wasm32")]
    {
        log::info!("[browser-fs-debug] runtime poll entered");
        RUNTIMES.tokio_runtime.block_on(async {
            for _ in 0..64 {
                tokio::task::yield_now().await;
            }
        });
        log::info!("[browser-fs-debug] runtime poll completed");
    }
}

fn lsp_err(err: ResponseError) -> JsValue {
    to_js_value(&err).unwrap()
}

fn lsp_serialize<T: serde::Serialize>(value: &T) -> JsValue {
    match to_js_value(value) {
        Ok(v) => v,
        Err(err) => lsp_err(internal_error(err.to_string())),
    }
}

// todo: poor performance, struct -> serde_json -> serde_wasm_bindgen ->
// serialize -> deserialize??
fn to_js_value<T: serde::Serialize>(value: &T) -> Result<JsValue, serde_wasm_bindgen::Error> {
    value.serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
}
