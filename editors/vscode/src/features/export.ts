import * as vscode from "vscode";
import { commands } from "vscode";
import type {
  ExportActionOpts,
  ExportOpts,
  ExportPdfOpts,
  ExportPngOpts,
  ExportSvgOpts,
  ExportTypliteOpts,
} from "../cmd.export";
import type { IContext } from "../context";
import { l10nMsg } from "../l10n";
import { type ExportResponse, tinymist } from "../lsp";
import { extensionState } from "../state";

/// These are names of the export functions in the LSP client, e.g. `exportPdf`, `exportHtml`.
export type ExportKind =
  | "Pdf"
  | "Html"
  | "Bundle"
  | "Svg"
  | "Png"
  | "Markdown"
  | "TeX"
  | "Text"
  | "Query";

export function exportActivate(context: IContext) {
  context.subscriptions.push(
    commands.registerCommand("tinymist.exportCurrentPdf", commandExportCurrentPdf),
    commands.registerCommand("tinymist.exportCurrentPdfFromContext", commandExportCurrentPdf),
    commands.registerCommand("tinymist.export", commandExport),
    commands.registerCommand("tinymist.exportCurrentFile", commandAskAndExport),
    commands.registerCommand("tinymist.showPdf", () => commandShow("Pdf")),
    commands.registerCommand("tinymist.exportCurrentFileAndShow", commandAskAndShow),
  );
}

export async function commandExportCurrentPdf(): Promise<ExportResponse | null> {
  let exportResponse: ExportResponse | null;
  try {
    exportResponse = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: l10nMsg("Exporting PDF"),
      },
      async () => await commandExport("Pdf"),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await vscode.window.showErrorMessage(
      l10nMsg("Failed to export PDF: {message}", { message }),
    );
    return null;
  }

  if (!exportResponse) {
    await vscode.window.showErrorMessage(l10nMsg("Failed to export PDF"));
    return null;
  }

  if ("path" in exportResponse && exportResponse.path) {
    await vscode.window.showInformationMessage(
      l10nMsg("Exported successfully to: {path}", { path: exportResponse.path }),
    );
  } else {
    await vscode.window.showInformationMessage(l10nMsg("Export completed"));
  }

  return exportResponse;
}

export interface QuickExportFormatMeta {
  label: string;
  description: string;
  exportKind: ExportKind;
  extraOpts?: ExportOpts;
  selectPages?: true | "merged";
}

export const quickExports: QuickExportFormatMeta[] = [
  {
    label: "PDF",
    description: l10nMsg("Export as PDF"),
    exportKind: "Pdf",
  },
  {
    label: l10nMsg("PDF (Specific Pages)"),
    description: l10nMsg("Export as PDF with specified pages"),
    exportKind: "Pdf",
    selectPages: true,
  },
  {
    label: l10nMsg("PNG (Merged)"),
    description: l10nMsg("Export as a single PNG by merging pages"),
    exportKind: "Png",
    selectPages: "merged",
  },
  {
    label: l10nMsg("PNG (Specific Pages)"),
    description: l10nMsg("Export the specified pages as multiple PNGs"),
    exportKind: "Png",
    selectPages: true,
  },
  {
    label: l10nMsg("SVG (Merged)"),
    description: l10nMsg("Export as a single SVG by merging pages"),
    exportKind: "Svg",
    selectPages: "merged",
  },
  {
    label: l10nMsg("SVG (Specific Pages)"),
    description: l10nMsg("Export the specified pages as multiple SVGs"),
    exportKind: "Svg",
    selectPages: true,
  },
  {
    label: "HTML",
    description: l10nMsg("Export as HTML"),
    exportKind: "Html",
  },
  {
    label: "Bundle",
    description: l10nMsg("Export as Bundle"),
    exportKind: "Bundle",
  },
  {
    label: "Markdown",
    description: l10nMsg("Export as Markdown"),
    exportKind: "Markdown",
  },
  {
    label: "TeX",
    description: l10nMsg("Export as TeX"),
    exportKind: "TeX",
  },
  {
    label: "Text",
    description: l10nMsg("Export as Text"),
    exportKind: "Text",
  },
  // {
  //   label: "Query (JSON)",
  //   description: l10nMsg("Query current document and export the result as a JSON file"),
  //   exportKind: "Query",
  // },
  // {
  //   label: "Query (YAML)",
  //   description: l10nMsg("Query current document and export the result as a YAML file"),
  //   exportKind: "Query",
  // },
  // {
  //   label: "Query (Task)",
  //   description: l10nMsg("Query current document and export the result as a file. We will ask a few questions and update the tasks.json file for you."),
  //   exportKind: "Query",
  // },
  // {
  //   label: l10nMsg("PNG (Task)"),
  //   description: l10nMsg("Export as PNG (and update tasks.json)"),
  //   exportKind: "Png",
  // },
  // {
  //   label: l10nMsg("SVG (Task)"),
  //   description: l10nMsg("Export as SVG (and update tasks.json)"),
  //   exportKind: "Svg",
  // },
];

async function askAndRun<T>(
  title: string,
  cb: (meta: QuickExportFormatMeta) => T,
): Promise<T | undefined> {
  const availableExports = extensionState.features.web
    ? quickExports.filter((format) => format.exportKind !== "Bundle")
    : quickExports;
  const picked = await vscode.window.showQuickPick(availableExports, { title });

  if (picked === undefined) {
    return;
  }

  picked.extraOpts ??= {};

  if (picked.exportKind === "TeX") {
    const processor = await vscode.window.showInputBox({
      title: l10nMsg("TeX processor"),
      placeHolder: l10nMsg(
        "A typst file help export to TeX, e.g. `/ieee-tex.typ` or `@local/ieee-tex:0.1.0`",
      ),
      prompt: l10nMsg(
        "Hint: you can create and find local packages in the sidebar. See https://github.com/Myriad-Dreamin/tinymist/tree/bc15eb55cee9f9b048aafd5f22472894961a1f51/editors/vscode/e2e-workspaces/ieee-paper for more information.",
      ),
    });

    if (processor) {
      (picked.extraOpts as ExportTypliteOpts).processor = processor;
    }
  }

  if (!(await askPageSelection(picked))) {
    return; // cancelled
  }

  return cb(picked);
}

/** returns false if export cancelled */
export async function askPageSelection(picked: QuickExportFormatMeta) {
  const selectPages = picked.selectPages;
  if (!selectPages) {
    return true; // no need to select pages
  }

  picked.extraOpts ??= {};
  if (selectPages === "merged") {
    (picked.extraOpts as ExportPngOpts | ExportSvgOpts).merge = {};
    return true;
  }

  const pages = await vscode.window.showInputBox({
    title: l10nMsg("Pages to export"),
    value: "1",
    placeHolder: l10nMsg("e.g. `1-3,5,7-9`, leave empty for all pages"),
    prompt: l10nMsg("Specify the pages you want to export"),
    validateInput: validatePageRanges,
  });
  if (pages === undefined) {
    return false; // cancelled
  }

  const pageRanges = pages.split(",");
  (picked.extraOpts as ExportPdfOpts | ExportPngOpts | ExportSvgOpts).pages = pageRanges;

  if (
    (picked.exportKind === "Png" || picked.exportKind === "Svg") &&
    !(pageRanges.length === 1 && !pageRanges[0].includes("-"))
  ) {
    // multiple pages, ask for page number template
    // if only one page without range, no need for page number template
    const pageNumberTemplate = await vscode.window.showInputBox({
      title: "Page Number Template",
      placeHolder: l10nMsg("e.g., `page-{0p}-of-{t}.png`"),
      prompt: l10nMsg(
        "A page number template must be present if the source document renders to multiple pages. Use `{p}` for page numbers, `{0p}` for zero padded page numbers and `{t}` for page count.\nLeave empty for default naming scheme.",
      ),
    });
    if (pageNumberTemplate === undefined) {
      return false; // cancelled
    }

    if (pageNumberTemplate.length > 0) {
      // only set if not empty
      (picked.extraOpts as ExportPngOpts | ExportSvgOpts).pageNumberTemplate = pageNumberTemplate;
    }
  }

  return true;
}

export async function commandAskAndExport(): Promise<ExportResponse | null> {
  return (
    (await askAndRun(l10nMsg("Pick a method to export"), (picked) => {
      return commandExport(picked.exportKind, picked.extraOpts);
    })) ?? null
  );
}

export async function commandAskAndShow(): Promise<void> {
  return await askAndRun(l10nMsg("Pick a method to export and show"), (picked) => {
    return commandShow(picked.exportKind, picked.extraOpts);
  });
}

export async function commandExport(
  kind: ExportKind,
  opts?: ExportOpts,
  actionOpts?: ExportActionOpts,
): Promise<ExportResponse | null> {
  if (extensionState.features.web && kind === "Bundle") {
    await vscode.window.showErrorMessage(
      "Directory-based Typst Bundle export is not available in the browser-only extension.",
    );
    return null;
  }

  const sourceUri = vscode.window.activeTextEditor?.document.uri;
  if (!sourceUri) {
    return null;
  }

  const response = await tinymist[`export${kind}`](
    sourceUri.fsPath,
    opts,
    extensionState.features.web ? { ...actionOpts, write: false, open: false } : actionOpts,
  );

  if (!extensionState.features.web || !response || "message" in response) {
    return response;
  }

  const persisted = await persistBrowserExport(response, kind, sourceUri);
  return persisted ? response : null;
}

const EXPORT_EXTENSIONS: Record<ExportKind, string> = {
  Pdf: "pdf",
  Html: "html",
  Bundle: "zip",
  Svg: "svg",
  Png: "png",
  Markdown: "md",
  TeX: "tex",
  Text: "txt",
  Query: "json",
};

function decodeExportData(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function defaultExportPath(sourceUri: vscode.Uri, kind: ExportKind): string {
  const sourcePath = sourceUri.path;
  const slash = sourcePath.lastIndexOf("/");
  const filename = sourcePath.slice(slash + 1);
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const directory = slash >= 0 ? sourcePath.slice(0, slash + 1) : "/";
  return `${directory}${stem}.${EXPORT_EXTENSIONS[kind]}`;
}

function withPageSuffix(filePath: string, page: number): string {
  const slash = filePath.lastIndexOf("/");
  const dot = filePath.lastIndexOf(".");
  const insertAt = dot > slash ? dot : filePath.length;
  return `${filePath.slice(0, insertAt)}-page-${page}${filePath.slice(insertAt)}`;
}

/**
 * Maps canonical file paths returned by the WASM language server back to the
 * VS Code workspace filesystem provider. Browser workspaces may use virtual
 * schemes such as vscode-vfs or vscode-test-web instead of file:.
 */
function workspaceUriForExportPath(sourceUri: vscode.Uri, serverPath: string): vscode.Uri {
  if (sourceUri.scheme === "file") {
    return vscode.Uri.file(serverPath);
  }

  const isWithinFolder = (candidate: string, folderPath: string) => {
    let root = folderPath || "/";
    while (root.length > 1 && root.endsWith("/")) {
      root = root.slice(0, -1);
    }
    return candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`);
  };

  const folder = (vscode.workspace.workspaceFolders ?? [])
    .filter(
      ({ uri }) =>
        uri.scheme === sourceUri.scheme &&
        uri.authority === sourceUri.authority &&
        isWithinFolder(sourceUri.path, uri.path) &&
        isWithinFolder(serverPath, uri.path),
    )
    .sort((left, right) => right.uri.path.length - left.uri.path.length)[0];

  if (folder) {
    return folder.uri.with({ path: serverPath, query: "", fragment: "" });
  }

  // Preserve the source provider as a safe fallback; never silently switch a
  // virtual workspace export to an unrelated file: provider.
  return sourceUri.with({ path: serverPath, query: "", fragment: "" });
}

async function writeBrowserFile(targetUri: vscode.Uri, encoded: string): Promise<void> {
  const separator = targetUri.path.lastIndexOf("/");
  const parent = separator > 0 ? targetUri.path.slice(0, separator) : "/";
  await vscode.workspace.fs.createDirectory(
    targetUri.with({ path: parent, query: "", fragment: "" }),
  );
  await vscode.workspace.fs.writeFile(targetUri, decodeExportData(encoded));
}

async function persistBrowserExport(
  response: ExportResponse,
  kind: ExportKind,
  sourceUri: vscode.Uri,
): Promise<boolean> {
  const defaultPath = defaultExportPath(sourceUri, kind);
  const choosePath = async (suggestedPath: string): Promise<vscode.Uri | undefined> => {
    return await vscode.window.showSaveDialog({
      defaultUri: workspaceUriForExportPath(sourceUri, suggestedPath),
      saveLabel: l10nMsg("Save export"),
      filters: { [EXPORT_EXTENSIONS[kind].toUpperCase()]: [EXPORT_EXTENSIONS[kind]] },
    });
  };

  if ("items" in response) {
    const items = response.items;
    if (items.length === 0) {
      return false;
    }

    const existingPaths = items.map((item) => item.path);
    const allPathsAreDistinct =
      existingPaths.every((itemPath): itemPath is string => !!itemPath) &&
      new Set(existingPaths).size === existingPaths.length;

    if (allPathsAreDistinct) {
      for (const item of items) {
        if (item.data && item.path) {
          await writeBrowserFile(workspaceUriForExportPath(sourceUri, item.path), item.data);
        }
      }
      return true;
    }

    const firstUri = await choosePath(items[0].path || defaultPath);
    if (!firstUri) {
      return false;
    }

    for (const item of items) {
      if (!item.data) {
        continue;
      }
      const targetUri = firstUri.with({
        path: withPageSuffix(firstUri.path, item.page + 1),
        query: "",
        fragment: "",
      });
      await writeBrowserFile(targetUri, item.data);
      item.path = targetUri.path;
    }
    return true;
  }

  if (!response.data) {
    return false;
  }

  const targetUri = response.path
    ? workspaceUriForExportPath(sourceUri, response.path)
    : await choosePath(defaultPath);
  if (!targetUri) {
    return false;
  }
  await writeBrowserFile(targetUri, response.data);
  response.path = targetUri.path;
  return true;
}

/**
 * Implements the functionality for the 'Show PDF' button shown in the editor title
 * if a `.typ` file is opened.
 */
export async function commandShow(kind: ExportKind, extraOpts?: ExportOpts): Promise<void> {
  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor === undefined) {
    return;
  }

  const actionOpts: ExportActionOpts = {};

  const conf = vscode.workspace.getConfiguration("tinymist");
  const openIn: string = extensionState.features.web
    ? "editorTab"
    : conf.get("showExportFileIn") || "editorTab";

  // Telling the language server to open the file instead of using
  // ```
  // vscode.env.openExternal(exportUri);
  // ```
  // , which is buggy.
  //
  // See https://github.com/Myriad-Dreamin/tinymist/issues/837
  // Also see https://github.com/microsoft/vscode/issues/85930
  const openBySystemDefault = !extensionState.features.web && openIn === "systemDefault";
  if (openBySystemDefault && kind !== "Bundle") {
    actionOpts.open = true;
  }

  // Gets the template from the convertExtension configuration
  const language = activeEditor.document.languageId;
  if (language === "markdown") {
    const convertExtension = conf.get("convertExtension");
    if (convertExtension && convertExtension instanceof Array) {
      const convertExtensionItem = convertExtension.find((item: any) => item.language === language);
      if (convertExtensionItem && convertExtensionItem.processor) {
        extraOpts ||= {};
        // todo: processor type
        (extraOpts as ExportPdfOpts).processor = convertExtensionItem.processor;
      }
    }
  }

  // only creates pdf if it does not exist yet
  const exportResponse = await commandExport(kind, extraOpts, actionOpts);
  if (!exportResponse || "message" in exportResponse) {
    // show error message
    await vscode.window.showErrorMessage(`Failed to export ${kind}: ${exportResponse?.message}`);
    return;
  }

  if (kind === "Bundle") {
    const exportPath =
      "items" in exportResponse ? exportResponse.items[0]?.path : exportResponse.path;
    if (!exportPath) {
      await vscode.window.showErrorMessage(`Failed to export ${kind}: no path in response`);
      return;
    }
    if (extensionState.features.web) {
      await vscode.window.showInformationMessage(
        l10nMsg("Bundle exported to: {path}", { path: exportPath }),
      );
    } else {
      await commands.executeCommand("revealFileInOS", vscode.Uri.file(exportPath));
    }
    return;
  }

  const showRes = await showExportFileIn(exportResponse, openIn, activeEditor.document.uri);
  if (!showRes) {
    await vscode.window.showErrorMessage(`Failed to export ${kind}: no path in response`);
  }
}

async function showExportFileIn(
  exportResponse: ExportResponse,
  openIn: string,
  sourceUri: vscode.Uri,
): Promise<boolean> {
  // PDF export is not paged. The response should be a simple object.
  // For other formats, we just open the first page.
  const exportPath =
    "items" in exportResponse ? exportResponse.items[0]?.path : exportResponse.path;
  if (!exportPath) {
    return false;
  }

  switch (openIn) {
    case "systemDefault":
      break;
    case "editorTab": {
      // find and replace exportUri
      const exportUri = workspaceUriForExportPath(sourceUri, exportPath);
      const uriToFind = exportUri.toString();
      findTab: for (const editor of vscode.window.tabGroups.all) {
        for (const tab of editor.tabs) {
          if ((tab.input as any)?.uri?.toString() === uriToFind) {
            await vscode.window.tabGroups.close(tab, true);
            break findTab;
          }
        }
      }

      // here we can be sure that the pdf exists
      await commands.executeCommand("vscode.open", exportUri, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
      } as vscode.TextDocumentShowOptions);
      break;
    }
    default:
      vscode.window.showWarningMessage(
        `Unknown value of "tinymist.showExportFileIn", expected "systemDefault" or "editorTab", got "${openIn}"`,
      );
  }

  return true;
}

function validatePageRanges(value: string): string | undefined {
  if (!value.trim()) {
    return; // Allow empty input
  }
  const parts = value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p);
  for (const part of parts) {
    const rangeParts = part.split("-").map((s) => s.trim());
    if (rangeParts.length > 2) {
      return l10nMsg("Invalid page range format: {range}", { range: part });
    }
    if (rangeParts.length === 1) {
      // Single page
      const num = parseInt(rangeParts[0], 10);
      if (Number.isNaN(num) || num <= 0) {
        return l10nMsg("Invalid page number: {page}", { page: part });
      }
    } else {
      // Range
      const [startStr, endStr] = rangeParts;
      let startNum: number | undefined;
      let endNum: number | undefined;
      if (startStr) {
        startNum = parseInt(startStr, 10);
        if (Number.isNaN(startNum) || startNum <= 0) {
          return l10nMsg("Invalid page range: {range}", { range: part });
        }
      }
      if (endStr) {
        endNum = parseInt(endStr, 10);
        if (Number.isNaN(endNum) || endNum <= 0) {
          return l10nMsg("Invalid page range: {range}", { range: part });
        }
      }
      if (startNum !== undefined && endNum !== undefined && startNum > endNum) {
        return l10nMsg("Invalid page range: {range}", { range: part });
      }
      // If both start and end are empty, invalid
      if (!startStr && !endStr) {
        return l10nMsg("Invalid page range: {range}", { range: part });
      }
    }
  }
  return;
}
