import { expect, test, vi } from "vitest";

vi.mock("vscode", () => ({}));
vi.mock("../config", () => ({
  resolvePreviewerValue: (value: string | undefined) => value,
}));
vi.mock("../lsp", () => ({
  tinymist: {},
}));
vi.mock("../state", () => ({
  extensionState: { features: { web: false } },
}));
vi.mock("../util", () => ({
  loadHTMLFile: vi.fn(),
}));

import { previewerProviderForHost } from "./previewer";

test("browser preview always selects Tinymist's bundled previewer", () => {
  expect(previewerProviderForHost(undefined, true)).toBeUndefined();
  expect(previewerProviderForHost("html:/workspace/preview.html", true)).toBeUndefined();
  expect(previewerProviderForHost("publisher.third-party-previewer", true)).toBeUndefined();
});

test("native preview preserves the configured previewer", () => {
  expect(previewerProviderForHost(undefined, false)).toBeUndefined();
  expect(previewerProviderForHost("html:/workspace/preview.html", false)).toBe(
    "html:/workspace/preview.html",
  );
  expect(previewerProviderForHost("publisher.third-party-previewer", false)).toBe(
    "publisher.third-party-previewer",
  );
});
