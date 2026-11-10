import { PreviewMode } from "typst-dom/typst-doc.mjs";
import {
  TypstPreviewDocument as TypstDocument,
  TypstDomHookedElement,
  TypstDomWindowElement,
} from "typst-dom/index.preview.mjs";
import {
  rendererBuildInfo,
  createTypstRenderer,
} from "@myriaddreamin/typst.ts/dist/esm/renderer.mjs";
import renderModule from "@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url";
// @ts-ignore
// import { RenderSession as RenderSession2 } from "@myriaddreamin/typst-ts-renderer/pkg/wasm-pack-shim.mjs";
import { RenderSession } from "@myriaddreamin/typst.ts/dist/esm/renderer.mjs";
import { WebSocketSubject, webSocket } from "rxjs/webSocket";
import { Subject, Subscription, buffer, debounceTime, fromEvent, tap } from "rxjs";
import { handleHtmlPreviewFrame } from "./html-preview";
export { PreviewMode } from "typst-dom/typst-doc.mjs";

// for debug propose
// queryObjects((window as any).TypstRenderSession);
(window as any).TypstRenderSession = RenderSession;
// (window as any).TypstRenderSessionKernel = RenderSession2;

const enc = new TextEncoder();
const dec = new TextDecoder();
const NOT_AVAILABLE = "current not available";
const COMMA = enc.encode(",");

type PreviewSvgRasterMetrics = {
  rasterWidth: number;
  rasterHeight: number;
  nonWhitePixelCount: number;
  opaquePixelCount: number;
};

/**
 * Rasterizes a copy of the actual rendered SVG with the source nodes'
 * computed styles. This distinguishes a genuinely painted page from an SVG
 * element that merely exists in the Webview DOM.
 */
async function measurePreviewSvgPixels(svg: SVGSVGElement): Promise<PreviewSvgRasterMetrics> {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  const sourceElements = [svg, ...Array.from(svg.querySelectorAll<SVGElement>("*"))];
  const clonedElements = [clone, ...Array.from(clone.querySelectorAll<SVGElement>("*"))];
  const styleProperties = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-opacity",
    "opacity",
    "display",
    "visibility",
    "color",
    "font-family",
    "font-size",
    "font-weight",
    "text-anchor",
    "dominant-baseline",
    "clip-path",
    "mask",
    "filter",
    "shape-rendering",
    "transform",
    "vector-effect",
  ];

  for (let index = 0; index < sourceElements.length; index++) {
    const computed = getComputedStyle(sourceElements[index]);
    const target = clonedElements[index] as SVGElement;
    for (const property of styleProperties) {
      const value = computed.getPropertyValue(property);
      if (value) {
        target.style.setProperty(property, value);
      }
    }
  }

  const bounds = svg.getBoundingClientRect();
  const rasterWidth = Math.max(1, Math.min(256, Math.round(bounds.width)));
  const rasterHeight = Math.max(1, Math.min(256, Math.round(bounds.height)));
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new Error(`Cannot rasterize an SVG with empty bounds: ${bounds.width}×${bounds.height}`);
  }

  // Inline SVG elements can rely on CSS sizing from the containing Webview.
  // A serialized standalone image needs intrinsic dimensions of its own.
  clone.setAttribute("width", String(rasterWidth));
  clone.setAttribute("height", String(rasterHeight));
  if (!clone.hasAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
  }

  const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
    type: "image/svg+xml;charset=utf-8",
  });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = rasterWidth;
    canvas.height = rasterHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("Could not create a canvas context to inspect preview paint");
    }

    // A white backing makes black/dark Typst text and graphics measurable
    // even when the source SVG uses a transparent page background.
    context.fillStyle = "#fff";
    context.fillRect(0, 0, rasterWidth, rasterHeight);
    context.drawImage(bitmap, 0, 0, rasterWidth, rasterHeight);

    const pixels = context.getImageData(0, 0, rasterWidth, rasterHeight).data;
    let nonWhitePixelCount = 0;
    let opaquePixelCount = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const [red, green, blue, alpha] = pixels.subarray(offset, offset + 4);
      if (alpha > 8) {
        opaquePixelCount += 1;
        if (red < 245 || green < 245 || blue < 245) {
          nonWhitePixelCount += 1;
        }
      }
    }

    return { rasterWidth, rasterHeight, nonWhitePixelCount, opaquePixelCount };
  } finally {
    bitmap.close();
  }
}
export interface WsArgs {
  url: string;
  previewMode: PreviewMode;
  isContentPreview: boolean;
}

export async function wsMain({ url, previewMode, isContentPreview }: WsArgs) {
  if (!url) {
    const hookedElem = document.getElementById("typst-app");
    if (hookedElem) {
      hookedElem.innerHTML = "";
    }
    return () => {};
  }
  const windowElem = document.getElementById("typst-container")! as TypstDomWindowElement;

  let disposed = false;
  let $ws: WebSocketSubject<ArrayBuffer> | undefined = undefined;
  const subsribes: Subscription[] = [];

  function createSvgDocument(kModule: RenderSession) {
    const hookedElem = document.getElementById("typst-app")! as TypstDomHookedElement;
    if (hookedElem.firstElementChild?.tagName !== "svg") {
      hookedElem.innerHTML = "";
    }
    const resizeTarget = document.getElementById("typst-container-main")!;

    const svgDoc = new TypstDocument({
      windowElem,
      hookedElem,
      kModule,
      previewMode,
      isContentPreview,
      // set rescale target to `body`
      retrieveDOMState() {
        return {
          width: resizeTarget.clientWidth,
          height: resizeTarget.offsetHeight,
          boundingRect: resizeTarget.getBoundingClientRect(),
        };
      },
    });

    // drag (panal resizing) -> rescaling
    // window.onresize = () => svgDoc.rescale();
    subsribes.push(fromEvent(window, "resize").subscribe(() => svgDoc.addViewportChange()));

    if (!isContentPreview) {
      subsribes.push(
        fromEvent(resizeTarget, "scroll")
          .pipe(debounceTime(500))
          .subscribe(() => svgDoc.addViewportChange()),
      );
    }

    // Handle messages sent from the extension to the webview
    subsribes.push(
      fromEvent<MessageEvent>(window, "message").subscribe((event) => {
        const message = event.data; // The json data that the extension sent
        switch (message.type) {
          case "outline": {
            svgDoc.setOutineData(message.outline);
            break;
          }
        }
      }),
    );

    const focusInput = () => {
      const inpPageSelector = document.getElementById("typst-page-selector") as
        | HTMLSelectElement
        | undefined;
      if (inpPageSelector) {
        inpPageSelector.focus();
      }
    };

    const blurInput = () => {
      const inpPageSelector = document.getElementById("typst-page-selector") as
        | HTMLSelectElement
        | undefined;
      if (inpPageSelector) {
        inpPageSelector.blur();
      }
    };

    const updateDiff = (diff: number) => () => {
      const pageSelector = document.getElementById("typst-page-selector") as
        | HTMLSelectElement
        | undefined;

      if (pageSelector) {
        console.log("updateDiff", diff);
        const v = pageSelector.value;
        if (v.length === 0) {
          return;
        }
        const page = Number.parseInt(v) + diff;
        if (page <= 0) {
          return;
        }
        if (svgDoc.setPartialPageNumber(page)) {
          pageSelector.value = page.toString();
          blurInput();
        }
      }
    };

    const updatePrev = updateDiff(-1);
    const updateNext = updateDiff(1);

    const pagePrevSelector = document.getElementById("typst-page-prev-selector");
    if (pagePrevSelector) {
      pagePrevSelector.addEventListener("click", updatePrev);
    }
    const pageNextSelector = document.getElementById("typst-page-next-selector");
    if (pageNextSelector) {
      pageNextSelector.addEventListener("click", updateNext);
    }

    if (previewMode === PreviewMode.Slide) {
      {
        const inpPageSelector = document.getElementById("typst-page-selector") as
          | HTMLSelectElement
          | undefined;
        if (inpPageSelector) {
          inpPageSelector.addEventListener("input", () => {
            if (inpPageSelector.value.length === 0) {
              return;
            }
            const page = Number.parseInt(inpPageSelector.value);
            svgDoc.setPartialPageNumber(page);
          });
        }
      }
    }

    const toggleHelp = () => {
      const help = document.getElementById("typst-help-panel");
      console.log("toggleHelp", help);
      if (help) {
        help.classList.toggle("hidden");
      }
    };

    const removeHelp = () => {
      const help = document.getElementById("typst-help-panel");
      if (help) {
        help.classList.add("hidden");
      }
    };

    const toggleTheme = () => {
      const typstApp = document.getElementById("typst-app");
      console.log("toggleTheme", typstApp);
      if (typstApp) {
        typstApp.classList.toggle("invert-colors");
      }
    };

    const helpButton = document.getElementById("typst-top-help-button");
    helpButton?.addEventListener("click", toggleHelp);

    window.addEventListener("keydown", (e) => {
      // Browser and OS shortcuts (Cmd+T, Ctrl+L, Cmd+Up, ...) are not ours.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      let handled = true;

      const scrollDelta = 50;

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowUp":
          if (previewMode === PreviewMode.Slide) {
            blurInput();
            removeHelp();
            updatePrev();
          } else {
            handled = false;
          }
          break;
        case " ":
        case "ArrowRight":
        case "ArrowDown":
          if (previewMode === PreviewMode.Slide) {
            blurInput();
            removeHelp();
            updateNext();
          } else {
            handled = false;
          }
          break;
        case "j":
          resizeTarget.scrollBy({ top: + scrollDelta, behavior: "instant" });
          break;
        case "k":
          resizeTarget.scrollBy({ top: - scrollDelta, behavior: "instant" });
          break;
        case "h":
          resizeTarget.scrollBy({ top: - scrollDelta * 10, behavior: "smooth" });
          break;
        case "l":
          resizeTarget.scrollBy({ top: + scrollDelta * 10, behavior: "smooth" });
          break;
        case "?":
          blurInput();
          toggleHelp();
          break;
        case "g":
          removeHelp();
          focusInput();
          break;
        case "Escape":
          removeHelp();
          blurInput();
          handled = false;
          break;
        case "t":
          toggleTheme();
          break;
        default:
          handled = false;
      }

      if (handled) {
        e.preventDefault();
      }
    });

    return svgDoc;
  }

  function setupSocket(svgDoc: TypstDocument): () => void {
    windowElem.documents.push(svgDoc);

    // todo: reconnect setTimeout(() => setupSocket(svgDoc), 1000);
    $ws = webSocket<ArrayBuffer>({
      url,
      binaryType: "arraybuffer",
      serializer: (t) => t,
      deserializer: (event) => event.data,
      openObserver: {
        next: (e) => {
          const sock = e.target;
          console.log("WebSocket connection opened", sock);
          windowElem.typstWebsocket = sock as any;
          svgDoc.reset();
          windowElem.typstWebsocket.send("current");
        },
      },
      closeObserver: {
        next: (e) => {
          console.log("WebSocket connection closed", e);
          $ws?.unsubscribe();
          if (!disposed) {
            setTimeout(() => setupSocket(svgDoc), 1000);
          }
        },
      },
    });

    const batchMessageChannel = new Subject<ArrayBuffer>();

    const dispose = () => {
      disposed = true;
      svgDoc.dispose();
      const index = windowElem.documents.indexOf(svgDoc);
      if (index >= 0) {
        windowElem.documents.splice(index, 1);
      }
      for (const sub of subsribes.splice(0, subsribes.length)) {
        sub.unsubscribe();
      }
      $ws?.complete();
    };

    // window.typstWebsocket = new WebSocket("ws://127.0.0.1:23625");

    $ws.subscribe({
      next: (data) => batchMessageChannel.next(data), // Called whenever there is a message from the server.
      error: (err) => console.log("WebSocket Error: ", err), // Called if at any point WebSocket API signals some kind of error.
      complete: () => console.log("complete"), // Called when connection is closed (for whatever reason).
    });

    subsribes.push(
      batchMessageChannel
        .pipe(buffer(batchMessageChannel.pipe(debounceTime(0))))
        .pipe(
          tap((dataList) => {
            console.log(`batch ${dataList.length} messages`);
          }),
        )
        .subscribe((dataList) => {
          dataList.map(processMessage);
        }),
    );

    function processMessage(data: ArrayBuffer) {
      if (!(data instanceof ArrayBuffer)) {
        if (data === NOT_AVAILABLE) {
          return;
        }

        console.error("WebSocket data is not a ArrayBuffer", data);
        return;
      }

      const buffer = data;
      const messageData = new Uint8Array(buffer);

      const message_idx = messageData.indexOf(COMMA[0]);
      const message = [
        dec.decode(messageData.slice(0, message_idx).buffer),
        messageData.slice(message_idx + 1),
      ];
      console.log("recv", message[0], messageData.length);
      const browserState = (window as any).vscode_state;
      const vscodeApi = (window as any).__tinymistVscodeApi;
      if (browserState?.browserTransport === true) {
        vscodeApi?.postMessage?.({
          type: "tinymist-preview-frame-parsed",
          taskId: browserState.taskId,
          frameKind: message[0],
          byteLength: messageData.byteLength,
        });
      }
      // console.log(message[0], message[1].length);
      if (isContentPreview) {
        // whether to scroll to the content preview when user updates document
        const autoScrollContentPreview = true;
        if (!autoScrollContentPreview && message[0] === "jump") {
          return;
        }

        // "viewport": viewport change to document doesn't affect content preview
        // "partial-rendering": content previe always render partially
        // "cursor": currently not supported
        if (
          message[0] === "viewport" ||
          message[0] === "partial-rendering" ||
          message[0] === "cursor"
        ) {
          return;
        }
      }

      if (message[0] === "jump" || message[0] === "viewport") {
        const rootElem = document.getElementById("typst-app")?.firstElementChild;

        // todo: aware height padding
        let currentPageNumber = 1;
        if (previewMode === PreviewMode.Slide) {
          currentPageNumber = svgDoc.getPartialPageNumber();
        } else if (rootElem) {
          currentPageNumber = windowElem.currentPosition(rootElem)?.page || 1;
        }

        let positions = dec
          .decode((message[1] as any).buffer)
          .split(",")
          .map((t: string) => t.trim())
          .filter((t: string) => t.length > 0);

        // choose the page, x, y closest to the current page
        const [page, x, y] = positions.reduce(
          (acc, cur) => {
            const [page, x, y] = cur.split(" ").map(Number);
            const current_page = currentPageNumber;
            // If page distance is the same, choose the last one
            if (Math.abs(page - current_page) <= Math.abs(acc[0] - current_page)) {
              return [page, x, y];
            }
            return acc;
          },
          [Number.MAX_SAFE_INTEGER, 0, 0],
        );
        // console.log("resolved", page, x, y, "from", currentPageNumber);

        let pageToJump = page;
        if (pageToJump === Number.MAX_SAFE_INTEGER) {
          return;
        }

        if (previewMode === PreviewMode.Slide) {
          const pageSelector = document.getElementById("typst-page-selector") as
            | HTMLSelectElement
            | undefined;
          if (svgDoc.setPartialPageNumber(page)) {
            if (pageSelector) {
              pageSelector.value = page.toString();
            }
            // pageToJump = 1;
            // todo: hint location
            return;
          } else {
            return;
          }
        }

        if (rootElem) {
          /// Note: when it is really scrolled, it will trigger `svgDoc.addViewportChange`
          /// via `window.onscroll` event
          windowElem.handleTypstLocation(rootElem, pageToJump, x, y);
        }
        return;
      } else if (message[0] === "cursor") {
        // todo: aware height padding
        const [page, x, y] = dec
          .decode((message[1] as any).buffer)
          .split(" ")
          .map(Number);
        console.log("cursor", page, x, y);
        svgDoc.setCursor(page, x, y);
        svgDoc.addViewportChange(); // todo: synthesizing cursor event
        return;
      } else if (message[0] === "cursor-paths") {
        // todo: aware height padding
        const paths = JSON.parse(dec.decode((message[1] as any).buffer));
        console.log("cursor-paths", paths);
        svgDoc.impl.setCursorPaths(paths);
        return;
      } else if (message[0] === "partial-rendering") {
        console.log("Experimental feature: partial rendering enabled");
        svgDoc.setPartialRendering(true);
        return;
      } else if (message[0] === "invert-colors") {
        const rawStrategy = dec.decode((message[1] as any).buffer).trim();
        const strategy =
          INVERT_COLORS_STRATEGY.find((t) => t === rawStrategy) ||
          (JSON.parse(rawStrategy) as StrategyMap);
        console.log("Experimental feature: invert colors strategy taken:", strategy);
        ensureInvertColors(document.getElementById("typst-app"), strategy);
        return;
      } else if (message[0] === "outline") {
        console.log("Experimental feature: outline rendering");
        return;
      }

      if (handleHtmlPreviewFrame(message[0] as string, message[1] as Uint8Array, url, dec)) {
        return;
      }

      try {
        svgDoc.addChangement(message as any);
      } catch (error) {
        const browserState = (window as any).vscode_state;
        const vscodeApi = (window as any).__tinymistVscodeApi;
        if (browserState?.browserTransport === true) {
          vscodeApi?.postMessage?.({
            type: "tinymist-preview-frame-error",
            taskId: browserState.taskId,
            message: error instanceof Error ? error.stack || error.message : String(error),
          });
        }
        throw error;
      }
      if ((window as any).vscode_state?.browserTransport === true) {
        const app = document.getElementById("typst-app");
        const appRect = app?.getBoundingClientRect();
        const svgs = Array.from(app?.querySelectorAll("svg") ?? []);
        const visibleSvgs = svgs.filter((svg) => {
          const rect = svg.getBoundingClientRect();
          const style = getComputedStyle(svg);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0
          );
        });
        const contentElements = Array.from(
          app?.querySelectorAll(
            "svg path, svg text, svg image, svg use, svg rect, svg circle, svg line, svg polygon, svg polyline, svg foreignObject",
          ) ?? [],
        );
        const visibleContentElements = contentElements.filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            (rect.width > 0 || rect.height > 0) &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity) > 0
          );
        });
        const firstSvg = visibleSvgs[0];
        const firstSvgRect = firstSvg?.getBoundingClientRect();
        const baseMetrics = {
          appWidth: appRect?.width ?? 0,
          appHeight: appRect?.height ?? 0,
          svgCount: svgs.length,
          visibleSvgCount: visibleSvgs.length,
          svgWidth: firstSvgRect?.width ?? 0,
          svgHeight: firstSvgRect?.height ?? 0,
          contentElementCount: contentElements.length,
          visibleContentElementCount: visibleContentElements.length,
          markupLength: app?.innerHTML.length ?? 0,
        };
        const publishRenderMetrics = (raster: Partial<PreviewSvgRasterMetrics> & { rasterError?: string }) => {
          window.dispatchEvent(
            new CustomEvent("tinymist-preview-rendered", {
              detail: { ...baseMetrics, ...raster },
            }),
          );
        };
        if (!firstSvg) {
          publishRenderMetrics({
            rasterWidth: 0,
            rasterHeight: 0,
            nonWhitePixelCount: 0,
            opaquePixelCount: 0,
            rasterError: "No visible SVG page was available to rasterize",
          });
        } else {
          void measurePreviewSvgPixels(firstSvg).then(
            publishRenderMetrics,
            (error: unknown) =>
              publishRenderMetrics({
                rasterWidth: 0,
                rasterHeight: 0,
                nonWhitePixelCount: 0,
                opaquePixelCount: 0,
                rasterError: error instanceof Error ? error.message : String(error),
              }),
          );
        }
      }
    }

    return dispose;
  }

  let plugin = createTypstRenderer();
  await plugin.init({ getModule: () => renderModule });

  return new Promise<() => void>((resolveDispose) =>
    plugin.runWithSession((kModule) /* module kernel from wasm */ => {
      return new Promise(async (kernelDispose) => {
        console.log("plugin initialized, build info:", await rendererBuildInfo());

        const wsDispose = setupSocket(createSvgDocument(kModule));

        // todo: plugin init and setup socket at the same time
        resolveDispose(() => {
          // dispose ws first
          wsDispose();
          // dispose kernel then
          kernelDispose(undefined);
        });
      });
    }),
  );
}

/** The strategy to set invert colors, see editors/vscode/package.json for enum descriptions */
const INVERT_COLORS_STRATEGY = ["never", "auto", "always"] as const;
/** The value of strategy constant */
type StrategyKey = (typeof INVERT_COLORS_STRATEGY)[number];
/** The map from element kinds to strategy */
type StrategyMap = Partial<Record<"rest" | "image", StrategyKey>>;

function ensureInvertColors(root: HTMLElement | null, strategy: StrategyKey | StrategyMap) {
  if (!root) {
    return;
  }

  // Uniforms type of strategy to `TargetMap`
  if (typeof strategy === "string") {
    strategy = { rest: strategy };
  }

  let autoDecision: { value: boolean } | undefined = undefined;
  /**
   * Handles invert colors mode based on a string enumerated strategy.
   * @param strategy - The strategy set by user.
   * @returns needInvertColor - Use or not use invert color.
   */
  const decide = (strategy: StrategyKey) => {
    switch (strategy) {
      case "never":
        return false;
      default:
        console.warn("Unknown invert-colors strategy:", strategy);
        return false;
      case "auto":
        return (autoDecision ||= { value: determineInvertColor() }).value;
      case "always":
        return true;
    }
  };

  root.classList.toggle("invert-colors", decide(strategy?.rest || "never"));
  root.classList.toggle("normal-image", !decide(strategy?.image || strategy?.rest || "never"));

  function determineInvertColor() {
    const vscodeAPI = typeof acquireVsCodeApi !== "undefined";

    if (vscodeAPI) {
      // vscode-dark, high-contrast, vscode-light
      const cls = document.body.classList;
      const themeIsDark =
        (cls.contains("vscode-dark") || cls.contains("vscode-high-contrast")) &&
        !cls.contains("vscode-light");

      if (themeIsDark) {
        console.log("invert-colors because detected by vscode theme", document.body.className);
        return true;
      }
    } else {
      // prefer dark mode
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
        console.log("invert-colors because detected by (prefers-color-scheme: dark)");
        return true;
      }
    }

    console.log("doesn't invert-colors because none of dark mode detected");
    return false;
  }
}
