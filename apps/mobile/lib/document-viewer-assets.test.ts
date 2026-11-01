import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ download: vi.fn(), text: vi.fn() }));
vi.mock("expo-asset", () => ({
  Asset: { fromModule: (id: unknown) => ({ downloadAsync: () => mocks.download(id) }) },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    text() {
      return mocks.text(this.uri);
    }
  },
}));
vi.mock("./document-viewer-modules", () => ({
  DOCUMENT_VIEWER_MODULES: { pdf: "pdf", office: "office" },
}));

const root = path.resolve(__dirname, "..");

describe("documentViewerHtml", () => {
  it("reads each bundled page once and retries after a failure", async () => {
    const { documentViewerHtml } = await import("./document-viewer-assets");
    mocks.download.mockRejectedValueOnce(new Error("offline"));
    await expect(documentViewerHtml("pdf")).rejects.toThrow("offline");
    mocks.download.mockImplementation(async (id: unknown) => ({
      localUri: `file:///bundle/${String(id)}.html`,
    }));
    mocks.text.mockImplementation(async (uri: string) => `<html>${uri}</html>`);
    await expect(documentViewerHtml("pdf")).resolves.toContain("pdf");
    await expect(documentViewerHtml("pdf")).resolves.toContain("pdf");
    await expect(documentViewerHtml("office")).resolves.toContain("office");
    expect(mocks.text).toHaveBeenCalledTimes(2);
  });
});

describe("bundled viewer assets", () => {
  it("are offline pages locked down by CSP", () => {
    for (const name of ["pdf", "office"]) {
      const html = readFileSync(path.join(root, "assets/viewers", `${name}.html`), "utf8");
      expect(html).toContain(
        `content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'`,
      );
      expect(html).not.toMatch(/<script[^>]+src=/);
      expect(html).not.toContain("/*VIEWER*/");
    }
  });

  it("match a fresh build of viewers/ (run pnpm --filter @rakazo/mobile build:viewers)", async () => {
    const { buildViewerPages } = await import("../scripts/build-file-viewers.mjs");
    const pages = await buildViewerPages();
    expect(Object.keys(pages)).toEqual(["pdf", "office"]);
    for (const [name, html] of Object.entries(pages)) {
      expect(
        readFileSync(path.join(root, "assets/viewers", `${name}.html`), "utf8") === html,
        name,
      ).toBe(true);
    }
  });
});
