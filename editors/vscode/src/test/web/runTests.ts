import * as vscode from "vscode";

type PreviewTask = {
  taskId: string;
  panel: boolean;
  source?: { kind?: string };
  frontendStarted: boolean;
  browserTransportEnabled: boolean;
  frontendTaskId?: string;
  framesFromServer: number;
  framesToServer: number;
  renderedFrames: number;
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
      commands.includes("typst-preview.preview");
  });

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert(workspace, "VS Code Web test workspace was not opened");

  await vscode.workspace.getConfiguration("tinymist.preview").update(
    "scrollSync",
    "onSelectionChange",
    vscode.ConfigurationTarget.Workspace,
  );

  const firstSource = [
    "#set page(width: 360pt, height: 240pt, margin: 20pt)",
    "#set text(size: 12pt)",
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
  await waitForTask(firstTaskId, (task) =>
    task.frontendStarted &&
    task.framesFromServer > 0 &&
    task.framesToServer > 0 &&
    task.renderedFrames > 0,
  );

  await waitFor("Typst preview outline", async () => {
    const state = await inspectPreviewState();
    return state.outlineItems.some((item) => item.title.includes("Browser preview acceptance"))
      ? state.outlineItems
      : undefined;
  });

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
    await waitForTask(secondTaskId, (task) =>
      task.frontendStarted && task.framesFromServer > 0 && task.renderedFrames > 0,
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
