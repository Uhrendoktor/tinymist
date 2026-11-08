import {
  createConnection,
  BrowserMessageReader,
  BrowserMessageWriter,
} from "vscode-languageserver/browser";

import { InitializeRequest } from "vscode-languageserver";

// @ts-ignore
import init, { TinymistLanguageServer } from "tinymist-web";
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

    /**
     * The events are stored in the array and will be processed after the response is sent to the client.
     */
    let events: any[] = [];

    /**
     * The bridge between the server in wasm and the client.
     */
    stage = "construct Rust language server";
    reportStartup(stage);
    const bridge = new TinymistLanguageServer({
      sendEvent: (event: any): void => void events.push(event),
      sendRequest({ id, method, params }: any): void {
        connection
          .sendRequest(method, params)
          .then((result: any) => bridge.on_response({ id, result }))
          .catch((err: any) =>
            bridge.on_response({ id, error: { code: -32603, message: err.toString() } }),
          );
      },
      sendNotification: ({ method, params }: any): void =>
        void connection.sendNotification(method, params),
      // Rust's browser package registry needs a synchronous resolver. The
      // browser distribution currently has no populated package cache, so
      // unresolved package specs deliberately return undefined (NotFound)
      // instead of failing server construction because the callback is absent.
      resolveFn: (_spec: any): string | undefined => undefined,
    });
    reportStartup("Rust language server constructed");

    // Post-processes server events after sent responses to the client.
    const h = <T>(res: T): T => {
      while (events.length > 0) {
        for (const event of events.splice(0)) {
          bridge.on_event(event);
        }
      }
      return res;
    };

    connection.onInitialize((params) => h(bridge.on_request(InitializeRequest.method, params)));
    connection.onRequest((m, p) => h(bridge.on_request(m, p)));
    connection.onNotification((m, p) => h(bridge.on_notification(m, p)));

    reportStartup("language server ready");
    connection.sendNotification("serverWorkerReady");
    // Starts the language server.
    connection.listen();
  } catch (error) {
    reportStartupError(stage, error);
    throw error;
  }
}

void startServer();
