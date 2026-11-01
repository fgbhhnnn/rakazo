// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, createElement, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  webview: vi.fn(),
  inject: vi.fn(),
  markdown: vi.fn(),
  html: vi.fn(),
  symbol: vi.fn(),
  share: vi.fn(),
  fileUri: vi.fn(),
  viewerHtml: vi.fn(),
  files: new Map<string, string>(),
}));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    View: (props: { children?: ReactNode; accessibilityLabel?: string }) =>
      createElement("div", { "aria-label": props.accessibilityLabel }, props.children),
    ScrollView: box,
    SafeAreaView: box,
    Modal: box,
    Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
    ActivityIndicator: (props: { accessibilityLabel?: string }) =>
      createElement("progress", { "aria-label": props.accessibilityLabel }),
    Alert: { alert: vi.fn() },
    StyleSheet: { create: <T,>(styles: T) => styles, absoluteFill: {} },
  };
});
vi.mock("react-native-webview", () => ({
  WebView: forwardRef((props: Record<string, unknown>, ref) => {
    useImperativeHandle(ref, () => ({ injectJavaScript: mocks.inject }));
    mocks.webview(props);
    return createElement("iframe");
  }),
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    async text() {
      if (!mocks.files.has(this.uri)) throw new Error("missing");
      return mocks.files.get(this.uri);
    }
    async base64() {
      return Buffer.from(mocks.files.get(this.uri) ?? "").toString("base64");
    }
  },
}));
vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: string }) => {
    mocks.markdown(children);
    return createElement("article", null, children);
  },
}));
vi.mock("../components/sandboxed-html-preview", () => ({
  SandboxedHtmlPreview: ({ html }: { html: string }) => {
    mocks.html(html);
    return createElement("section");
  },
}));
vi.mock("../components/native-symbol", () => ({
  NativeSymbol: (props: Record<string, unknown>) => {
    mocks.symbol(props);
    return createElement("i");
  },
}));
vi.mock("../components/glass-icon-button", () => ({
  GlassIconButton: (props: { accessibilityLabel: string; onPress: () => void }) =>
    createElement("button", {
      type: "button",
      "aria-label": props.accessibilityLabel,
      onClick: props.onPress,
    }),
}));
vi.mock("../lib/appearance", () => ({
  mobileTokens: () => ({
    background: "bg",
    border: "b",
    foreground: "fg",
    mutedForeground: "mfg",
    destructive: "red",
  }),
}));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ t: (text: string) => text }) }));
vi.mock("../lib/native", () => ({ useResolvedAppearance: () => "light" }));
vi.mock("../lib/native-controls", () => ({ iosAtLeast: () => false }));
vi.mock("../lib/user-error", () => ({ errorText: (_: unknown, fallback: string) => fallback }));
vi.mock("../lib/artifact-open", () => ({
  artifactFileUri: mocks.fileUri,
  openMobileArtifact: mocks.share,
}));
vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("../lib/document-viewer-assets", () => ({ documentViewerHtml: mocks.viewerHtml }));

import { FILE_KIND_COLORS, type FileIcon } from "@rakazo/chat-ui/file-kinds";
import { FileArtifactViewer } from "../components/file-artifact-viewer";
import { FILE_ICON_SYMBOLS, FileKindIcon } from "../components/file-kind-icon";
import { FileViewerBody, hasMobileFileViewer } from "../components/file-viewer";
import { mimeBadgeLabel } from "./artifacts";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(mocks)) if (typeof mock === "function") mock.mockReset();
  mocks.files.clear();
  mocks.viewerHtml.mockImplementation(async (asset: string) => `<html>${asset}</html>`);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
const render = (node: ReactNode) => act(async () => root.render(node));
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const lastWebView = () => mocks.webview.mock.lastCall?.[0] as Record<string, any>;

describe("hasMobileFileViewer", () => {
  it.each([
    ["report.pdf", "application/pdf", true],
    ["data.csv", "text/csv", true],
    ["book.xlsx", "application/octet-stream", true],
    ["old.xls", "application/vnd.ms-excel", true],
    ["memo.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", true],
    ["notes.md", "text/markdown", true],
    ["run.log", "text/plain", true],
    ["main.py", "text/x-python", true],
    ["page.html", "text/html", true],
    [
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      false,
    ],
    ["legacy.doc", "application/msword", false],
    ["bundle.zip", "application/zip", false],
  ])("%s → %s", (name, mimeType, expected) => {
    expect(hasMobileFileViewer({ name, mimeType })).toBe(expected);
  });
});

describe("FileKindIcon", () => {
  it("has a native symbol for every shared file icon", () => {
    expect(Object.keys(FILE_ICON_SYMBOLS).sort()).toEqual(Object.keys(FILE_KIND_COLORS).sort());
  });

  it.each([
    ["a.pdf", "application/pdf", "pdf", "PDF"],
    ["a.xlsx", "", "sheet", "XLSX"],
    ["a.csv", "text/csv", "sheet", "CSV"],
    ["a.docx", "", "doc", "DOCX"],
    ["a.pptx", "", "slides", "PPTX"],
  ] as const)("draws %s in its type color with a %s badge", async (name, mimeType, icon, badge) => {
    await render(<FileKindIcon name={name} mimeType={mimeType} size={36} />);
    expect(mocks.symbol.mock.lastCall?.[0]).toMatchObject({
      ...FILE_ICON_SYMBOLS[icon as FileIcon],
      color: FILE_KIND_COLORS[icon as FileIcon],
    });
    expect(container.textContent).toBe(badge);
  });

  it("drops the badge on small chips", async () => {
    await render(<FileKindIcon name="a.pdf" size={20} />);
    expect(container.textContent).toBe("");
  });

  it("labels artifact rows with the same badge", () => {
    expect(
      [
        "text/html",
        "text/markdown",
        "application/pdf",
        "image/png",
        "application/json",
        "text/csv",
      ].map(mimeBadgeLabel),
    ).toEqual(["HTML", "MD", "PDF", "PNG", "JSON", "CSV"]);
  });
});

describe("FileViewerBody", () => {
  it("renders a CSV as a markdown table", async () => {
    mocks.files.set("file:///a.csv", "\uFEFFname,qty\napple,3\n");
    await render(<FileViewerBody uri="file:///a.csv" name="a.csv" mimeType="text/csv" />);
    await settle();
    expect(mocks.markdown.mock.lastCall?.[0]).toContain("| name | qty |");
    expect(mocks.markdown.mock.lastCall?.[0]).toContain("| apple | 3 |");
  });

  it("pretty-prints JSON and fences code", async () => {
    mocks.files.set("file:///a.json", '{"a":[1,2]}');
    await render(<FileViewerBody uri="file:///a.json" name="a.json" mimeType="application/json" />);
    await settle();
    expect(mocks.markdown.mock.lastCall?.[0]).toContain('```json\n{\n  "a": [');
  });

  it("shows HTML in the sandboxed preview", async () => {
    mocks.files.set("file:///p.html", "<h1>x</h1>");
    await render(<FileViewerBody uri="file:///p.html" name="p.html" mimeType="text/html" />);
    await settle();
    expect(mocks.html).toHaveBeenLastCalledWith("<h1>x</h1>");
  });

  it("says so when the file cannot be read", async () => {
    await render(<FileViewerBody uri="file:///gone.txt" name="gone.txt" mimeType="text/plain" />);
    await settle();
    expect(container.textContent).toContain("Could not load this file.");
  });

  it.each([
    ["r.pdf", "application/pdf", "pdf", "pdf"],
    [
      "b.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "office",
      "spreadsheet",
    ],
    [
      "m.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "office",
      "docx",
    ],
  ])(
    "opens %s in the offline %s viewer page and hands it the bytes",
    async (name, mimeType, asset, viewer) => {
      mocks.files.set("file:///doc", "%PDF-1.7");
      await render(<FileViewerBody uri="file:///doc" name={name} mimeType={mimeType} />);
      await settle();
      expect(mocks.viewerHtml).toHaveBeenCalledWith(asset);
      const props = lastWebView();
      expect(props.source).toEqual({ html: `<html>${asset}</html>`, baseUrl: "about:blank" });
      expect(props).toMatchObject({
        allowFileAccess: false,
        domStorageEnabled: false,
        sharedCookiesEnabled: false,
      });
      expect(props.onShouldStartLoadWithRequest({ url: "about:blank" })).toBe(true);
      expect(props.onShouldStartLoadWithRequest({ url: "https://evil.example" })).toBe(false);
      expect(props.onShouldStartLoadWithRequest({ url: "file:///data/secret" })).toBe(false);
      expect(container.querySelector("progress")).not.toBeNull();
      await act(async () =>
        props.onMessage({ nativeEvent: { data: JSON.stringify({ type: "loaded" }) } }),
      );
      await settle();
      const script = mocks.inject.mock.lastCall?.[0] as string;
      expect(script).toBe(
        `window.rakazoOpen(${JSON.stringify({ viewer, name, base64: Buffer.from("%PDF-1.7").toString("base64") })});true;`,
      );
      await act(async () =>
        lastWebView().onMessage({ nativeEvent: { data: JSON.stringify({ type: "ready" }) } }),
      );
      expect(container.querySelector("progress")).toBeNull();
    },
  );

  it("falls back to a share hint when the viewer page reports an error", async () => {
    await render(<FileViewerBody uri="file:///doc" name="r.pdf" mimeType="application/pdf" />);
    await settle();
    await act(async () =>
      lastWebView().onMessage({
        nativeEvent: { data: JSON.stringify({ type: "error", message: "Invalid PDF" }) },
      }),
    );
    expect(container.textContent).toContain(
      "Could not preview this file. Share it to open it in another app.",
    );
    expect(container.querySelector("iframe")).toBeNull();
  });
});

describe("FileArtifactViewer", () => {
  it("downloads through the artifact cache, shows the file in-app and keeps share", async () => {
    mocks.fileUri.mockResolvedValue("file:///cache/a.csv");
    mocks.share.mockResolvedValue(undefined);
    mocks.files.set("file:///cache/a.csv", "x,y\n1,2\n");
    const onClose = vi.fn();
    await render(
      <FileArtifactViewer
        threadTarget={{ botId: "bot-1" }}
        target={{ artifactId: "art-1", name: "a.csv", mimeType: "text/csv" }}
        onClose={onClose}
      />,
    );
    await settle();
    expect(mocks.fileUri).toHaveBeenCalledWith({ botId: "bot-1" }, "art-1", "text/csv");
    expect(mocks.markdown.mock.lastCall?.[0]).toContain("| x | y |");
    expect(container.querySelector('[aria-label="CSV"]')).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Share {name}"]')!.click(),
    );
    expect(mocks.share).toHaveBeenCalledWith({ botId: "bot-1" }, "art-1", "a.csv", "text/csv");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Close preview"]')!.click(),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the download error instead of a blank viewer", async () => {
    mocks.fileUri.mockRejectedValue(new Error("network"));
    await render(
      <FileArtifactViewer
        threadTarget={{ groupId: "g-1" }}
        target={{ artifactId: "art-2", name: "r.pdf", mimeType: "application/pdf" }}
        onClose={vi.fn()}
      />,
    );
    await settle();
    expect(mocks.fileUri).toHaveBeenCalledWith({ groupId: "g-1" }, "art-2", "application/pdf");
    expect(container.textContent).toContain("Could not load this file.");
  });
});
