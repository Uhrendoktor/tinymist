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
  });

  /// To this time, we start to allow vscode to receive messages from the worker.
  const client = new LanguageClient("tinymist", NAME, clientOptions, worker);
  /// Sets up the output channel for the client
  client.onNotification("tmLog", ({ data }) => clientOptions.outputChannel?.append(data));
  return client;
}
