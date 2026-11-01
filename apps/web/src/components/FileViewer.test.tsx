// @vitest-environment jsdom
import { FILE_KIND_COLORS } from "@rakazo/chat-ui/file-kinds";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";

const mocks = vi.hoisted(() => ({
  markdown: vi.fn(),
  html: vi.fn(),
  loadPdfJs: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => {
  const t = (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((text, part, index) => text + part + (values[index] ?? ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => {
    mocks.markdown(children);
    return <article data-testid="markdown">{children}</article>;
  },
}));
vi.mock("./SandboxedHtmlViewer", () => ({
  SandboxedHtmlViewer: ({ html }: { html: string }) => {
    mocks.html(html);
    return <iframe title="sandboxed" />;
  },
}));
vi.mock("../lib/pdfjs", () => ({ loadPdfJs: mocks.loadPdfJs }));
vi.mock("../lib/artifact-open", () => ({
  fetchArtifactBytes: mocks.fetch,
  downloadArtifact: vi.fn(),
  downloadArtifactBytes: vi.fn(),
}));

import { ArtifactFileCard } from "./ArtifactFileCard";
import { FileKindBadge, FileKindIcon } from "./FileKindIcon";
import { FileViewerBody } from "./FileViewer";
import { PdfViewer } from "./PdfViewer";

const encode = (text: string) => new TextEncoder().encode(text);
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(mocks)) mock.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const render = (node: ReactNode) => act(async () => root.render(node));
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  expect(check()).toBe(true);
}

describe("FileKindIcon", () => {
  it.each([
    ["report.pdf", "application/pdf", "pdf", "PDF"],
    ["sales.xlsx", "application/octet-stream", "sheet", "XLSX"],
    ["data.csv", "text/csv", "sheet", "CSV"],
    ["memo.docx", "", "doc", "DOCX"],
    ["deck.pptx", "", "slides", "PPTX"],
    ["bundle.zip", "application/zip", "archive", "ZIP"],
    ["main.ts", "", "code", "TS"],
    ["mystery", "application/x-unknown", "file", "FILE"],
  ])("draws %s as a %s tile with a %s badge", async (name, mimeType, icon, badge) => {
    await render(<FileKindIcon name={name} mimeType={mimeType} />);
    const tile = container.querySelector<HTMLElement>("[data-file-kind]")!;
    expect(tile.dataset.fileKind).toBe(icon);
    expect(tile.querySelector("svg")).not.toBeNull();
    expect(tile.textContent).toBe(badge);
    const badgeElement = tile.querySelector<HTMLElement>("span")!;
    expect(badgeElement.style.backgroundColor).toBe(hexToRgb(FILE_KIND_COLORS[icon as "pdf"]));
  });

  it("leaves the badge off small chips and offers the badge alone", async () => {
    await render(
      <>
        <FileKindIcon name="a.pdf" size={24} />
        <FileKindBadge name="a.docx" />
      </>,
    );
    expect(container.querySelector("[data-file-kind]")?.textContent).toBe("");
    expect(container.textContent).toBe("DOCX");
  });
});

describe("FileViewerBody", () => {
  it("renders a CSV as a table", async () => {
    await render(
      <FileViewerBody bytes={encode("name,qty\napple,3\n")} name="a.csv" mimeType="text/csv" />,
    );
    expect(mocks.markdown.mock.lastCall?.[0]).toContain(
      "| name | qty |\n| --- | --- |\n| apple | 3 |",
    );
  });

  it("pretty-prints JSON and fences source code", async () => {
    await render(
      <FileViewerBody bytes={encode('{"a":1}')} name="a.json" mimeType="application/json" />,
    );
    expect(mocks.markdown.mock.lastCall?.[0]).toContain('```json\n{\n  "a": 1\n}\n```');
    await render(
      <FileViewerBody bytes={encode("print(1)")} name="a.py" mimeType="text/x-python" />,
    );
    expect(mocks.markdown.mock.lastCall?.[0]).toContain("```python\nprint(1)\n```");
  });

  it("renders a workbook with SheetJS, loaded on demand", async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["名称", "数量"],
        ["苹果", 3],
      ]),
      "销售",
    );
    const bytes = new Uint8Array(
      XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer,
    );
    await render(
      <FileViewerBody
        bytes={bytes}
        name="s.xlsx"
        mimeType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      />,
    );
    await waitFor(() => mocks.markdown.mock.calls.length > 0);
    expect(mocks.markdown.mock.lastCall?.[0]).toContain("| 名称 | 数量 |");
    expect(mocks.markdown.mock.lastCall?.[0]).toContain("| 苹果 | 3 |");
  });

  it("shows a fallback when an Office file cannot be converted", async () => {
    await render(
      <FileViewerBody
        bytes={encode("not a docx")}
        name="m.docx"
        mimeType="application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      />,
    );
    await waitFor(() => container.textContent?.includes("Could not preview this file.") ?? false);
    expect(container.textContent).toContain("Download it to open it.");
    expect(mocks.html).not.toHaveBeenCalled();
  });

  it("opens a PDF in the pdf.js viewer", async () => {
    mocks.loadPdfJs.mockReturnValue(new Promise(() => {}));
    await render(<FileViewerBody bytes={encode("%PDF")} name="r.pdf" mimeType="application/pdf" />);
    expect(container.querySelector('[data-testid="pdf-pages"]')).not.toBeNull();
    expect(mocks.loadPdfJs).toHaveBeenCalledTimes(1);
  });
});

describe("PdfViewer", () => {
  it("draws pages with pdf.js and never enables eval or XFA", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    const getDocument = vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 2,
        destroy: async () => {},
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({
            width: 100 * scale,
            height: 140 * scale,
          }),
          render: () => ({ promise: Promise.resolve(), cancel() {} }),
          cleanup() {},
        }),
      }),
      destroy: async () => {},
    }));
    mocks.loadPdfJs.mockResolvedValue({ getDocument });
    await render(<PdfViewer bytes={encode("%PDF")} title="r.pdf" />);
    await waitFor(() => container.querySelectorAll("canvas").length === 2);
    expect(getDocument.mock.calls[0]).toEqual([
      expect.objectContaining({ isEvalSupported: false, enableXfa: false }),
    ]);
    expect(container.querySelector('[aria-label="Page 2 of 2"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Could not open this PDF");
  });

  it("offers download when pdf.js cannot open the file", async () => {
    mocks.loadPdfJs.mockResolvedValue({
      getDocument: () => ({
        promise: Promise.reject(new Error("Invalid PDF")),
        destroy: async () => {},
      }),
    });
    await render(<PdfViewer bytes={encode("nope")} title="bad.pdf" />);
    await waitFor(() => container.textContent?.includes("Could not open this PDF") ?? false);
  });
});

describe("ArtifactFileCard", () => {
  it("previews a CSV attachment in the app as a table and keeps download", async () => {
    mocks.fetch.mockResolvedValue(encode("x,y\n1,2\n"));
    await render(
      <ArtifactFileCard
        target={{ botId: "bot-1" }}
        artifactId="a-1"
        name="data.csv"
        mimeType="text/csv"
        size={8}
      />,
    );
    expect(container.querySelector("[data-file-kind]")?.textContent).toBe("CSV");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Preview data.csv"]')!.click(),
    );
    await waitFor(() => mocks.markdown.mock.calls.length > 0);
    expect(mocks.markdown.mock.lastCall?.[0]).toContain("| x | y |");
    expect(
      document.querySelectorAll('button[aria-label="Download data.csv"]').length,
    ).toBeGreaterThan(0);
  });

  it("keeps a slide deck as a download card with its PPTX badge", async () => {
    await render(
      <ArtifactFileCard
        target={{ botId: "bot-1" }}
        artifactId="a-2"
        name="deck.pptx"
        mimeType="application/vnd.openxmlformats-officedocument.presentationml.presentation"
        size={8}
      />,
    );
    expect(container.querySelector('button[aria-label="Preview deck.pptx"]')).toBeNull();
    expect(container.querySelector("[data-file-kind]")?.textContent).toBe("PPTX");
  });
});

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
