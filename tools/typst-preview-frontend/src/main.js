/// Import stylesheets for different components
// todo: refactor them, but we don't touch them in this PR
import "./typst.css";
import "./styles/toolbar.css";
import "./styles/layout.css";
import "./styles/help-panel.css";
import "./styles/outline.css";

import { wsMain, PreviewMode } from "./ws";
import { setupDrag } from "./drag";

const windowElem = document.getElementById("typst-container");
windowElem.documents = [];

/// Main entry point of the frontend program.
main();

function main() {
  const wsArgs = retrieveWsArgs();
  const { nextWs } = buildWs();
  window.onload = () => nextWs(wsArgs);
  setupVscodeChannel(nextWs);
  setupDrag();
}

/// Placeholders for typst-preview program initializing frontend
/// arguments.
function retrieveWsArgs() {
  /// The string `preview-arg:previewMode:Doc` is a placeholder
  /// It will be replaced by the actual preview mode.
  /// ```rs
  ///   let frontend_html = frontend_html.replace(
  ///     "preview-arg:previewMode:Doc", ...);
  /// ```
  let mode = "preview-arg:previewMode:Doc";
  /// Remove the placeholder prefix.
  mode = mode.replace("preview-arg:previewMode:", "");
  let previewMode = PreviewMode[mode];

  /// The string `ws://127.0.0.1:23625` is a placeholder
  /// Also, it is the default url to connect to.
  /// Note that we must resolve the url to an absolute url as
  /// the websocket connection requires an absolute url.
  ///
  /// See [WebSocket and relative URLs](https://github.com/whatwg/websockets/issues/20)
  let urlObject = new URL("ws://127.0.0.1:23625", window.location.href);
  /// Rewrite the protocol to websocket.
  urlObject.protocol = urlObject.protocol.replace("https:", "wss:").replace("http:", "ws:");
  if (location.href.startsWith("https://")) {
    urlObject.protocol = urlObject.protocol.replace("ws:", "wss:");
  }

  /// Return a `WsArgs` object.
  return { url: urlObject.href, previewMode, isContentPreview: false };
}

/// `buildWs` returns a object, which keeps track of websocket
///  connections.
function buildWs() {
  let previousDispose = Promise.resolve(() => {});
  /// `nextWs` will always hold a global unique websocket connection
  /// to the preview backend.
  function nextWs(nextWsArgs) {
    const previous = previousDispose;
    previousDispose = new Promise(async (resolve) => {
      /// Dispose the previous websocket connection.
      await previous.then((d) => d());
      /// Reset app mode before creating a new websocket connection.
      resetAppMode(nextWsArgs);
      /// Create a new websocket connection.
      resolve(wsMain(nextWsArgs));
    });
  }

  return { nextWs };

  function resetAppMode({ previewMode: mode, isContentPreview }) {
    const app = document.getElementById("typst-container");
    const helpPanel = document.getElementById("typst-help-panel");

    /// Set the root css selector to the content preview mode.
    app.classList.remove("content-preview");
    if (isContentPreview) {
      app.classList.add("content-preview");
    }

    /// Set the root css selector to the preview mode.
    app.classList.remove("mode-slide");
    app.classList.remove("mode-doc");
    helpPanel?.classList.remove("mode-slide");
    helpPanel?.classList.remove("mode-doc");
    if (mode === PreviewMode.Slide) {
      app.classList.add("mode-slide");
      helpPanel?.classList.add("mode-slide");
    } else if (mode === PreviewMode.Doc) {
      app.classList.add("mode-doc");
      helpPanel?.classList.add("mode-doc");
    } else {
      throw new Error(`Unknown preview mode: ${mode}`);
    }
  }
}

/// A frontend will try to setup a vscode channel if it is running
/// in vscode.
function setupVscodeChannel(nextWs) {
  const vscodeAPI = typeof acquireVsCodeApi !== "undefined" && acquireVsCodeApi();
  if (vscodeAPI?.postMessage) {
    vscodeAPI.postMessage({ type: "started" });
    // Native VS Code previews continue to use their real WebSocket endpoint.
    // Only the browser-only WASM extension opts into the Webview message bridge.
    if (window.vscode_state?.browserTransport === true) {
      const taskId = window.vscode_state.taskId;
      vscodeAPI.postMessage({ type: "tinymist-preview-started", taskId });
      window.addEventListener("tinymist-preview-rendered", () => {
        vscodeAPI.postMessage({ type: "tinymist-preview-rendered", taskId });
      });
      installVscodeWebSocket(vscodeAPI);
    }
  }
  if (vscodeAPI?.setState && window.vscode_state) {
    vscodeAPI.setState(window.vscode_state);
  }

  // Handle messages sent from the extension to the webview
  window.addEventListener("message", (event) => {
    const message = event.data; // The json data that the extension sent
    switch (message.type) {
      case "reconnect": {
        console.log("reconnect", message);
        nextWs({
          url: message.url,
          previewMode: PreviewMode[message.mode],
          isContentPreview: message.isContentPreview,
        });
        break;
      }
      case "outline": {
        console.log("outline", message);
        break;
      }
    }
  });
}


/**
 * Adapts the preview frontend's ordinary WebSocket API to the extension-host
 * message channel. The Rust preview renderer still speaks its existing
 * binary WebSocket protocol; only the browser transport is replaced.
 */
function installVscodeWebSocket(vscodeAPI) {
  const taskId = window.vscode_state?.taskId;
  if (!taskId) {
    console.warn("Tinymist Webview bridge was not given a preview task id");
    return;
  }
  const sockets = new Set();
  const encodeBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };
  const decodeBase64 = (encoded) => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  };

  class VscodeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = VscodeWebSocket.CONNECTING;
    binaryType = "blob";
    bufferedAmount = 0;
    extensions = "";
    protocol = "";
    url;
    onopen = null;
    onmessage = null;
    onerror = null;
    onclose = null;

    constructor(url, _protocols) {
      super();
      this.url = String(url);
      sockets.add(this);
      queueMicrotask(() => {
        if (this.readyState !== VscodeWebSocket.CONNECTING) return;
        this.readyState = VscodeWebSocket.OPEN;
        this.emit("open", new Event("open"));
      });
    }

    emit(type, event) {
      this.dispatchEvent(event);
      const handler = this["on" + type];
      if (typeof handler === "function") handler.call(this, event);
    }

    send(data) {
      if (this.readyState !== VscodeWebSocket.OPEN) {
        throw new Error("WebSocket is not open");
      }
      if (typeof data === "string") {
        vscodeAPI.postMessage({
          type: "tinymist-preview-frame",
          taskId,
          message: { taskId, kind: "text", data },
        });
        return;
      }
      if (data instanceof Blob) {
        void data.arrayBuffer().then((buffer) => this.send(buffer));
        return;
      }
      let buffer;
      if (data instanceof ArrayBuffer) {
        buffer = data;
      } else if (ArrayBuffer.isView(data)) {
        buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        throw new TypeError("Unsupported WebSocket frame type");
      }
      vscodeAPI.postMessage({
        type: "tinymist-preview-frame",
        taskId,
        message: { taskId, kind: "binary", data: encodeBase64(buffer) },
      });
    }

    close(code = 1000, reason = "") {
      if (this.readyState >= VscodeWebSocket.CLOSING) return;
      this.readyState = VscodeWebSocket.CLOSING;
      sockets.delete(this);
      this.readyState = VscodeWebSocket.CLOSED;
      this.emit("close", new CloseEvent("close", { code, reason, wasClean: true }));
    }

    receive(message) {
      if (this.readyState !== VscodeWebSocket.OPEN) return;
      if (message.kind === "ping") {
        vscodeAPI.postMessage({
          type: "tinymist-preview-frame",
          taskId,
          message: { taskId, kind: "pong", data: message.data },
        });
        return;
      }
      if (message.kind === "pong") return;
      const data = message.kind === "text" ? message.data : decodeBase64(message.data);
      this.emit("message", new MessageEvent("message", { data }));
    }
  }

  window.WebSocket = VscodeWebSocket;

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (
      message?.type !== "tinymist-preview-frame" ||
      message.taskId !== taskId ||
      !message.message
    ) {
      return;
    }
    for (const socket of sockets) {
      socket.receive(message.message);
    }
  });
}
