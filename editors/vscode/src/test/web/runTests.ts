import * as vscode from "vscode";

type PreviewTask = {
  taskId: string;
  panel: boolean;
  source?: { kind?: string };
  frontendStarted: boolean;
  browserTransportEnabled: boolean;
  webviewSocketReady: boolean;
  webviewFramesReceived: number;
  frontendFramesParsed: number;
  lastFrontendFrameKind?: string;
  lastFrontendFrameBytes?: number;
  frontendFrameError?: string;
  documentReady: boolean;
  bootstrapStatePresent: boolean;
  bootstrapBrowserTransport: boolean;
  bootstrapHref?: string;
  frontendError?: string;
  frontendTaskId?: string;
  framesFromServer: number;
  framesToServer: number;
  renderedFrames: number;
  renderMetrics?: {
    appWidth: number;
    appHeight: number;
    svgCount: number;
    visibleSvgCount: number;
    svgWidth: number;
    svgHeight: number;
    contentElementCount: number;
    visibleContentElementCount: number;
    markupLength: number;
    rasterWidth: number;
    rasterHeight: number;
    nonWhitePixelCount: number;
    opaquePixelCount: number;
    rasterError?: string;
  };
};

type PreviewState = {
  tasks: PreviewTask[];
  outlineItems: { title: string; span?: string; position?: unknown }[];
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor<T>(
  label: string,
  read: () => Promise<T | undefined | false>,
  timeoutMs = 180_000,
): Promise<T> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await read();
      if (value !== undefined && value !== false) return value as T;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ""}`);
}

async function inspectPreviewState(): Promise<PreviewState> {
  return (await vscode.commands.executeCommand(
    "tinymist.doInspectPreviewState",
  )) as PreviewState;
}

async function verifyWebviewModuleMessaging(): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "tinymist-webview-module-smoke-test",
    "Tinymist Webview Module Smoke Test",
    vscode.ViewColumn.One,
    { enableScripts: true },
  );
  let ready = false;
  const listener = panel.webview.onDidReceiveMessage((message) => {
    if (message?.type === "tinymist-webview-module-ready") {
      ready = true;
    }
  });
  panel.webview.html = `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body>
  <script type="module">
    const vscode = acquireVsCodeApi();
    vscode.postMessage({ type: "tinymist-webview-module-ready" });
  </script>
</body>
</html>`;

  try {
    await waitFor(
      "a minimal VS Code Webview module script to post a message",
      async () => ready || undefined,
      10_000,
    );
  } finally {
    listener.dispose();
    panel.dispose();
  }
}

async function waitForTask(taskId: string, predicate: (task: PreviewTask) => boolean) {
  try {
    return await waitFor(`preview task ${taskId}`, async () => {
      const state = await inspectPreviewState();
      const task = state.tasks.find((candidate) => candidate.taskId === taskId);
      return task && predicate(task) ? task : undefined;
    }, 45_000);
  } catch (error) {
    const state = await inspectPreviewState();
    const task = state.tasks.find((candidate) => candidate.taskId === taskId);
    throw new Error(
      `${String(error)}; last preview task state: ${JSON.stringify(task ?? null)}; ` +
        `all active tasks: ${JSON.stringify(state.tasks)}`,
    );
  }
}

async function createTypstDocument(
  workspace: vscode.Uri,
  filename: string,
  source: string,
): Promise<vscode.TextEditor> {
  const uri = vscode.Uri.joinPath(workspace, filename);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(source));
  const document = await vscode.workspace.openTextDocument(uri);
  return await vscode.window.showTextDocument(document);
}

export async function run(): Promise<void> {
  assert(vscode.env.uiKind === vscode.UIKind.Web, "Tests must run in the VS Code Web Extension Host");

  await verifyWebviewModuleMessaging();

  const extension = vscode.extensions.getExtension("myriad-dreamin.tinymist");
  assert(extension, "The browser-only Tinymist extension was not loaded");
  assert(extension.packageJSON.browser, "The VSIX must declare its browser entry point");
  assert(!extension.packageJSON.main, "The browser-only VSIX must not declare a Node main entry");

  await extension.activate();
  await waitFor("Tinymist preview commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    return commands.includes("tinymist.doInspectPreviewState") &&
      commands.includes("tinymist.doInspectPreviewHtml") &&
      commands.includes("typst-preview.preview") &&
      !commands.includes("typst-preview.browser") &&
      !commands.includes("typst-preview.browser-slide") &&
      !commands.includes("typst-preview.eject");
  });

  // Inspect the exact HTML served by the extension's active WASM language client.
  const previewHtmlInfo = (await vscode.commands.executeCommand(
    "tinymist.doInspectPreviewHtml",
  )) as {
    isString: boolean;
    length?: number;
    statePlaceholder?: boolean;
    documentReady?: boolean;
    frontendReady?: boolean;
    browserTransport?: boolean;
    assetsInline?: boolean;
    externalScripts?: string[];
    assetReferences?: string[];
  };
  console.log("Embedded WASM preview HTML:", JSON.stringify(previewHtmlInfo));
  assert(previewHtmlInfo?.isString, "The WASM language server did not return preview HTML");
  for (const marker of [
    "statePlaceholder",
    "documentReady",
    "frontendReady",
    "browserTransport",
    "assetsInline",
  ] as const) {
    assert(previewHtmlInfo[marker], `The embedded WASM preview HTML is missing ${marker}`);
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert(workspace, "VS Code Web test workspace was not opened");

  await vscode.workspace.getConfiguration("tinymist.preview").update(
    "scrollSync",
    "onSelectionChange",
    vscode.ConfigurationTarget.Workspace,
  );

  const firstSource = [
    "#set page(width: 360pt, height: 240pt, margin: 20pt)",
    "#set text(fill: black)",
    "= Browser preview acceptance",
    "First page content. ORIGINAL_MARKER.",
    "#pagebreak()",
    "= Incremental page",
    "#lorem(70)",
    "#pagebreak()",
    "= Third page",
    "#lorem(70)",
    "",
  ].join("\n");

  const firstEditor = await createTypstDocument(
    workspace,
    "tinymist-browser-preview.typ",
    firstSource,
  );
  const firstDocument = firstEditor.document;

  const firstResponse = (await vscode.commands.executeCommand(
    "typst-preview.preview",
  )) as { message?: string; taskId?: string } | undefined;
  assert(firstResponse?.message === "ok" && firstResponse.taskId, "Could not launch first browser preview");
  const firstTaskId = firstResponse.taskId;

  await waitForTask(firstTaskId, (task) => task.panel);
  const bootstrapTask = await waitForTask(firstTaskId, (task) => task.documentReady);
  assert(
    bootstrapTask.bootstrapStatePresent,
    `Preview Webview bootstrap did not receive its injected state: ${JSON.stringify(bootstrapTask)}`,
  );
  assert(
    bootstrapTask.bootstrapBrowserTransport,
    `Preview Webview bootstrap did not receive browserTransport=true: ${JSON.stringify(bootstrapTask)}`,
  );
  const renderedTask = await waitForTask(firstTaskId, (task) =>
    task.frontendStarted &&
    task.browserTransportEnabled &&
    task.webviewSocketReady &&
    task.framesFromServer > 0 &&
    task.framesToServer > 0 &&
    task.renderedFrames > 0 &&
    !!task.renderMetrics,
  );
  const renderMetrics = renderedTask.renderMetrics!;
  console.log("Browser preview DOM render metrics:", JSON.stringify(renderMetrics));
  assert(
    renderMetrics.appWidth > 0 && renderMetrics.appHeight > 0,
    `Preview app has no visible layout box: ${JSON.stringify(renderMetrics)}`,
  );
  assert(
    renderMetrics.svgCount > 0 && renderMetrics.visibleSvgCount > 0,
    `Preview did not create a visible SVG page: ${JSON.stringify(renderMetrics)}`,
  );
  assert(
    renderMetrics.svgWidth > 0 && renderMetrics.svgHeight > 0,
    `Rendered SVG has empty bounds: ${JSON.stringify(renderMetrics)}`,
  );
  assert(
    renderMetrics.contentElementCount > 0 &&
      renderMetrics.visibleContentElementCount > 0 &&
      renderMetrics.markupLength > 0,
    `Rendered SVG contains no visible page content: ${JSON.stringify(renderMetrics)}`,
  );
  assert(
    !renderMetrics.rasterError &&
      renderMetrics.rasterWidth > 0 &&
      renderMetrics.rasterHeight > 0 &&
      renderMetrics.opaquePixelCount > 0 &&
      renderMetrics.nonWhitePixelCount > 0,
    `Preview SVG painted no non-white pixels: ${JSON.stringify(renderMetrics)}`,
  );

  await waitFor("Typst preview outline", async () => {
    const state = await inspectPreviewState();
    return state.outlineItems.some((item) => item.title.includes("Browser preview acceptance"))
      ? state.outlineItems
      : undefined;
  });
  const compileErrors = vscode.languages
    .getDiagnostics(firstDocument.uri)
    .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error);
  assert(
    compileErrors.length === 0,
    `Dependency-free browser preview source must compile: ${JSON.stringify(compileErrors.map((item) => item.message))}`,
  );

  // Exercise a real browser export and read the result back through the
  // originating workspace provider. Set an explicit output template so this
  // acceptance test exercises persistence rather than the interactive Save As
  // path (which is tested separately by VS Code's save-dialog integration).
  await vscode.window.showTextDocument(firstDocument);
  await vscode.workspace.getConfiguration("tinymist").update(
    "outputPath",
    "$root/$dir/$name",
    vscode.ConfigurationTarget.Workspace,
  );
  const pdfExport = (await vscode.commands.executeCommand(
    "tinymist.export",
    "Pdf",
  )) as { path: string | null; data: string | null } | null;
  assert(
    pdfExport && typeof pdfExport.path === "string" && pdfExport.path,
    `Browser PDF export returned no output path: ${JSON.stringify(pdfExport)}`,
  );
  const exportedPdfUri = firstDocument.uri.with({
    path: pdfExport.path,
    query: "",
    fragment: "",
  });
  const exportedPdf = await vscode.workspace.fs.readFile(exportedPdfUri);
  assert(
    new TextDecoder().decode(exportedPdf.subarray(0, 5)) === "%PDF-",
    `Browser PDF export did not write a valid PDF at ${exportedPdfUri.toString()}`,
  );
  console.log(
    `Browser PDF export read-back passed: ${exportedPdfUri.toString()} (${exportedPdf.length} bytes)`,
  );

  // Exercise the source-to-preview scroll command through the Web Worker LSP client.
  await vscode.window.showTextDocument(firstDocument);
  await vscode.commands.executeCommand("typst-preview.sync", { taskId: firstTaskId });
  const beforeEdit = await inspectPreviewState();
  const initialRenderedFrames =
    beforeEdit.tasks.find((task) => task.taskId === firstTaskId)?.renderedFrames ?? 0;
  assert(initialRenderedFrames > 0, "The first preview did not render any frames");

  const marker = "ORIGINAL_MARKER";
  const markerOffset = firstDocument.getText().indexOf(marker);
  assert(markerOffset >= 0, "The incremental preview marker was not found in the source");
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    firstDocument.uri,
    new vscode.Range(
      firstDocument.positionAt(markerOffset),
      firstDocument.positionAt(markerOffset + marker.length),
    ),
    "UPDATED_MARKER",
  );
  assert(await vscode.workspace.applyEdit(edit), "Could not edit the preview source document");
  await firstDocument.save();
  await waitForTask(firstTaskId, (task) => task.renderedFrames > initialRenderedFrames);

  const secondEditor = await createTypstDocument(
    workspace,
    "tinymist-browser-preview-second.typ",
    [
      "#set page(width: 360pt, height: 240pt, margin: 20pt)",
      "= Independent preview task",
      "#lorem(60)",
      "#pagebreak()",
      "= Second task page two",
      "#lorem(60)",
      "",
    ].join("\n"),
  );
  const secondResponse = (await vscode.commands.executeCommand(
    "typst-preview.preview",
  )) as { message?: string; taskId?: string } | undefined;
  assert(secondResponse?.message === "ok" && secondResponse.taskId, "Could not launch second browser preview");
  const secondTaskId = secondResponse.taskId;
  assert(firstTaskId !== secondTaskId, "Independent documents reused the same preview task id");

  try {
    await waitForTask(secondTaskId, (task) => task.panel);
    const secondRenderedTask = await waitForTask(secondTaskId, (task) =>
      task.frontendStarted &&
      task.framesFromServer > 0 &&
      task.renderedFrames > 0 &&
      !!task.renderMetrics,
    );
    assert(
      secondRenderedTask.renderMetrics!.visibleSvgCount > 0 &&
        secondRenderedTask.renderMetrics!.visibleContentElementCount > 0 &&
        secondRenderedTask.renderMetrics!.nonWhitePixelCount > 0,
      `Second preview rendered no visible painted page content: ${JSON.stringify(secondRenderedTask.renderMetrics)}`,
    );

    await waitFor("two isolated browser preview tasks", async () => {
      const state = await inspectPreviewState();
      const taskIds = new Set(state.tasks.map((task) => task.taskId));
      return taskIds.has(firstTaskId) && taskIds.has(secondTaskId) && state.tasks.length === 2
        ? state
        : undefined;
    });

    await waitForTask(firstTaskId, (task) =>
      task.panel && task.renderedFrames > initialRenderedFrames,
    );

    await vscode.commands.executeCommand("tinymist.doDisposePreview", { taskId: secondTaskId });
    await waitFor("second preview disposal", async () => {
      const state = await inspectPreviewState();
      return state.tasks.length === 1 && state.tasks[0].taskId === firstTaskId ? state : undefined;
    });
  } finally {
    await vscode.commands.executeCommand("tinymist.doDisposePreview", { taskId: secondTaskId });
    await vscode.commands.executeCommand("tinymist.doDisposePreview", { taskId: firstTaskId });
    await waitFor("all browser preview tasks to be disposed", async () => {
      const state = await inspectPreviewState();
      return state.tasks.length === 0 ? state : undefined;
    });
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    void secondEditor;
  }

  console.log(
    "Tinymist Web Extension Host test passed: multi-page preview, outline, browser frame bridge, " +
      "incremental rendering, source-to-preview sync, isolated tasks, and disposal.",
  );
}
