import * as vscode from "vscode";
import { ExtensionContext, Uri } from "vscode";
import { LanguageClient, LanguageClientOptions } from "vscode-languageclient/browser";
import { TinymistConfig } from "./config";

const NAME = "Tinymist Typst Language Server";
const WORKER_STARTUP_TIMEOUT_MS = 5 * 60_000;

export async function createBrowserLanguageClient(
  context: ExtensionContext,
  _config: TinymistConfig,
  clientOptions: LanguageClientOptions,
): Promise<LanguageClient> {
  const serverMain = Uri.joinPath(context.extensionUri, "out/web-server.js");
  // @ts-ignore
  const worker = new Worker(serverMain.toString(true));

  // Trace the raw worker transport for the browser-only filesystem sync request.
  // BaseLanguageClient promises resolving do not by themselves prove that the
  // JSON-RPC request crossed the Worker boundary.
  const fsChangeRequestIds = new Set<string | number>();
  const summarizeWorkerMessage = (message: unknown) => {
    let value: any = message;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return undefined;
      }
    }
    if (!value || typeof value !== "object") return undefined;
    return value;
  };
  const originalWorkerPostMessage = worker.postMessage.bind(worker);
  (worker as any).postMessage = (...args: any[]) => {
    const message = summarizeWorkerMessage(args[0]);
    if (message?.method === "tinymist/fsChange") {
      console.log("[browser-fs-debug] raw Worker.postMessage fsChange", {
        id: message.id,
        params: message.params,
      });
      if (message.id !== undefined) fsChangeRequestIds.add(message.id);
    }
    return originalWorkerPostMessage(...args);
  };
  worker.addEventListener("message", (event: MessageEvent) => {
    const message = summarizeWorkerMessage(event.data);
    if (message?.id !== undefined && fsChangeRequestIds.has(message.id)) {
      console.log("[browser-fs-debug] raw Worker response for fsChange", {
        id: message.id,
        result: message.result,
        error: message.error,
      });
      fsChangeRequestIds.delete(message.id);
    }
  });

  /// Waits for the server worker to be ready before returning the client.
  /// Progress and errors are sent as control messages before the LSP client starts listening.
  await new Promise<void>((resolve, reject) => {
    let lastStage = "worker script loading";
    let settled = false;

    const cleanup = () => {
      clearTimeout(workerTimeout);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      worker.terminate();
      reject(error);
    };

    function onMessage(e: MessageEvent) {
      const message = e.data;
      if (!message || typeof message !== "object") return;

      if (message.method === "serverWorkerProgress") {
        lastStage = String(message.stage ?? lastStage);
        clientOptions.outputChannel?.appendLine(
          `WebAssembly worker startup: ${lastStage} (${message.elapsedMs ?? 0} ms)`,
        );
        return;
      }

      if (message.method === "serverWorkerError") {
        fail(
          new Error(
            `failed to initialize server worker during ${message.stage ?? lastStage}: ${message.message ?? "unknown worker error"}` +
              (message.stack ? `\n${message.stack}` : ""),
          ),
        );
        return;
      }

      if (message.method !== "serverWorkerReady" || settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    function onError(e: ErrorEvent) {
      fail(
        new Error(
          `failed to load server worker: ${e.message || "unknown worker error"}` +
            (e.filename ? ` (${e.filename}:${e.lineno ?? 0}:${e.colno ?? 0})` : ""),
        ),
      );
    }

    function onMessageError() {
      fail(new Error("failed to decode server worker startup message"));
    }

    const workerTimeout = setTimeout(() => {
      fail(
        new Error(
          `failed to initialize server worker: timeout during ${lastStage} after ${WORKER_STARTUP_TIMEOUT_MS} ms`,
        ),
      );
    }, WORKER_STARTUP_TIMEOUT_MS);

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);

    // Worker URLs can be rewritten to blob: URLs by browser extension hosts,
    // where relative URL resolution is not valid. Resolve the WASM resource in
    // the extension host and explicitly bootstrap the worker with its absolute URI.
    const wasmResource = Uri.joinPath(context.extensionUri, "out", "tinymist_bg.wasm");
    worker.postMessage({
      method: "tinymistInitialize",
      wasmUrl: wasmResource.toString(true),
    });
  });

  /// To this time, we start to allow vscode to receive messages from the worker.
  const client = new LanguageClient("tinymist", NAME, clientOptions, worker);
  /// Sets up the output channel for the client
  client.onNotification("tmLog", ({ data }) => {
    clientOptions.outputChannel?.append(data);
    if (
      typeof data === "string" &&
      (data.includes("[browser-preview-debug]") || data.includes("[browser-fs-debug]"))
    ) {
      console.log(data);
    }
  });
  return client;
}
