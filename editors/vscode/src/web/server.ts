import {
  createConnection,
  BrowserMessageReader,
  BrowserMessageWriter,
} from "vscode-languageserver/browser";

import { InitializeRequest } from "vscode-languageserver";
import { createBridgeCallDispatcher } from "./bridge-queue";

// @ts-ignore
import init, { init_runtime, TinymistLanguageServer } from "tinymist-web";
// @ts-ignore
import wasmURL from "../../../../target/wasm/tinymist_bg.wasm";

/**
 * The rust stack trace is deep and so we have to increase the limit to check full content.
 */
if ("stackTraceLimit" in Error) {
  Error.stackTraceLimit = 64;
}

const startupStartedAt = Date.now();

function reportStartup(stage: string) {
  self.postMessage({
    method: "serverWorkerProgress",
    stage,
    elapsedMs: Date.now() - startupStartedAt,
  });
}

function reportStartupError(stage: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  self.postMessage({
    method: "serverWorkerError",
    stage,
    message,
    stack,
  });
}

function waitForExtensionBootstrap(): Promise<string> {
  return new Promise((resolve) => {
    const onBootstrap = (event: MessageEvent) => {
      if (event.data?.method !== "tinymistInitialize") return;
      self.removeEventListener("message", onBootstrap);
      resolve(event.data.wasmUrl);
    };
    self.addEventListener("message", onBootstrap);
  });
}

async function startServer() {
  let stage = "create language-server connection";

  try {
    reportStartup("worker started");

    // Browser extension hosts may run Worker scripts through blob: URLs,
    // so the Worker cannot reliably resolve a sibling WASM asset itself. Wait
    // for the extension host to provide the absolute extension resource URI.
    stage = "waiting for extension resource URL";
    reportStartup(stage);
    const wasmResourceUrl = await waitForExtensionBootstrap();
    if (typeof wasmResourceUrl !== "string" || wasmResourceUrl.length === 0) {
      throw new Error("extension host did not provide a valid WASM resource URL");
    }

    const connection = createConnection(
      //@ts-ignore
      new BrowserMessageReader(self),
      //@ts-ignore
      new BrowserMessageWriter(self),
    );

    // Keep the WebAssembly module as a separate file. The async wasm-bindgen
    // initializer fetches the absolute resource URL resolved by the extension host.
    stage = `load WebAssembly module (${wasmURL})`;
    reportStartup(stage);
    await init(wasmResourceUrl);
    reportStartup("WebAssembly module initialized");
    console.log(`tinymist-web ${TinymistLanguageServer.version()} wasm is loaded...`);

    stage = "initialize Tokio runtime";
    reportStartup(stage);
    init_runtime();
    reportStartup("Tokio runtime initialized");

    /**
     * The events are stored in the array and will be processed after the response is sent to the client.
     */
    let events: any[] = [];
    const dispatchBridgeCall = createBridgeCallDispatcher();
    let invokeBridge: <T>(callback: () => T) => Promise<Awaited<T>> = (callback) =>
      dispatchBridgeCall(callback);

    /**
     * The bridge between the server in wasm and the client.
     */
    stage = "construct Rust language server";
    reportStartup(stage);
    const bridge = new TinymistLanguageServer({
      sendEvent: (event: any): void => void events.push(event),
      sendRequest({ id, method, params }: any): void {
        // Rust's WASM object has a mutable borrow while one of its exported
        // methods is running. Defer the cross-host request so its response
        // cannot re-enter that object on the same JavaScript call stack.
        queueMicrotask(() => {
          void connection
            .sendRequest(method, params)
            .then(
              (result: any) => invokeBridge(() => bridge.on_response({ id, result })),
              (err: any) =>
                invokeBridge(() =>
                  bridge.on_response({ id, error: { code: -32603, message: err.toString() } }),
                ),
            )
            .catch((error: unknown) => {
              console.error("Failed to deliver browser language-server response to WASM", error);
            });
        });
      },
      sendNotification({ method, params }: any): void {
        // Keep JavaScript callbacks outside the active WASM mutable borrow.
        queueMicrotask(() => {
          void connection.sendNotification(method, params).catch((error: unknown) => {
            console.error("Failed to send browser language-server notification", error);
          });
        });
      },
      // Rust's browser package registry needs a synchronous resolver. The
      // browser distribution currently has no populated package cache, so
      // unresolved package specs deliberately return undefined (NotFound)
      // instead of failing server construction because the callback is absent.
      resolveFn: (_spec: any): string | undefined => undefined,
    });
    reportStartup("Rust language server constructed");

    // Post-process server events only after the active WASM call has returned.
    const h = <T>(res: T): T => {
      while (events.length > 0) {
        for (const event of events.splice(0)) {
          bridge.on_event(event);
        }
      }
      return res;
    };

    // wasm-bindgen rejects recursive mutable access to an exported object.
    // Serialize JavaScript -> WASM entry points, releasing the queue as soon
    // as each synchronous method returns (not when its LSP Promise settles).
    invokeBridge = <T>(callback: () => T): Promise<Awaited<T>> =>
      dispatchBridgeCall(() => h(callback()));

    connection.onInitialize((params) =>
      invokeBridge(() => bridge.on_request(InitializeRequest.method, params)),
    );
    connection.onRequest("tinymist/fsChange", (params) => {
      // Keep this request method-specific: the browser filesystem provider must
      // deliver file bytes before the project's compile interrupt is processed.
      return invokeBridge(() => bridge.on_request("tinymist/fsChange", params));
    });
    connection.onRequest((m, p) => invokeBridge(() => bridge.on_request(m, p)));
    connection.onNotification((m, p) => {
      void invokeBridge(() => bridge.on_notification(m, p)).catch((error: unknown) => {
        console.error("Failed to handle browser language-server notification", error);
      });
    });

    reportStartup("language server ready");
    connection.sendNotification("serverWorkerReady");
    // Starts the language server.
    connection.listen();

    // A browser worker has no native Tokio executor thread. Keep its
    // current-thread runtime progressing between LSP and Webview messages.
    setInterval(() => {
      void invokeBridge(() => (bridge as any).poll_runtime()).catch((error: unknown) => {
        console.error("Failed to poll browser language-server runtime", error);
      });
    }, 16);
  } catch (error) {
    reportStartupError(stage, error);
    throw error;
  }
}

void startServer();
