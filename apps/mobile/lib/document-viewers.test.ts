// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import type { ViewerMessage, ViewerRequest } from "../viewers/host";

type ViewerWindow = Window & {
  ReactNativeWebView?: { postMessage(message: string): void };
  rakazoOpen?: (request: ViewerRequest) => Promise<void>;
};

function bridge(): ViewerMessage[] {
  const messages: ViewerMessage[] = [];
  (window as ViewerWindow).ReactNativeWebView = {
    postMessage: (message) => messages.push(JSON.parse(message) as ViewerMessage),
  };
  document.body.innerHTML = `<div id="root"></div>`;
  return messages;
}

const base64 = (bytes: Uint8Array | ArrayBuffer) =>
  Buffer.from(bytes as Uint8Array).toString("base64");

afterEach(() => {
  vi.resetModules();
  delete (window as ViewerWindow).rakazoOpen;
});

describe("viewer host", () => {
  it("announces itself, decodes the bytes and reports ready or the render error", async () => {
    const messages = bridge();
    const { hostViewer, base64ToBytes } = await import("../viewers/host");
    expect([...base64ToBytes(base64(new Uint8Array([0, 1, 254, 255])))]).toEqual([0, 1, 254, 255]);
    const seen: number[][] = [];
    hostViewer((bytes, request) => {
      if (request.name === "bad") throw new Error("broken file");
      seen.push([...bytes]);
    });
    expect(messages).toEqual([{ type: "loaded" }]);
    await (window as ViewerWindow).rakazoOpen!({
      viewer: "pdf",
      name: "ok",
      base64: base64(new Uint8Array([7, 8])),
    });
    await (window as ViewerWindow).rakazoOpen!({ viewer: "pdf", name: "bad", base64: "" });
    expect(seen).toEqual([[7, 8]]);
    expect(messages.slice(1)).toEqual([
      { type: "ready" },
      { type: "error", message: "broken file" },
    ]);
  });
});

describe("office viewer page", () => {
  it("renders every sheet as a capped table and escapes cell text", async () => {
    const messages = bridge();
    await import("../viewers/office");
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([
        ["名称", "价格"],
        ["<img src=x onerror=alert(1)>", 2],
      ]),
      "销售",
    );
    XLSX.utils.book_append_sheet(
      book,
      XLSX.utils.aoa_to_sheet([["i"], ...Array.from({ length: 700 }, (_, i) => [i])]),
      "Big",
    );
    const bytes = XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    await (window as ViewerWindow).rakazoOpen!({
      viewer: "spreadsheet",
      name: "t.xlsx",
      base64: base64(bytes),
    });
    expect(messages.at(-1)).toEqual({ type: "ready" });
    const page = document.getElementById("root")!;
    expect([...page.querySelectorAll("h3")].map((node) => node.textContent)).toEqual([
      "销售",
      "Big",
    ]);
    expect(page.querySelector("img")).toBeNull();
    expect(page.querySelector("td")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(page.querySelectorAll("table")[1]!.querySelectorAll("tr")).toHaveLength(501);
    expect(page.querySelector(".more")?.textContent).toBe("… 200 more rows");
  });

  it("renders a .docx without scripts, handlers or link targets", async () => {
    const messages = bridge();
    vi.doMock("@rakazo/chat-ui/office-preview", () => ({
      docxHtml: async () =>
        `<!DOCTYPE html><html><body><h1 onclick="x()">Report</h1><a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a><script>alert(1)</script><img src="https://tracker/x.png"><img src="data:image/png;base64,AA=="></body></html>`,
    }));
    await import("../viewers/office");
    await (window as ViewerWindow).rakazoOpen!({ viewer: "docx", name: "t.docx", base64: "" });
    expect(messages.at(-1)).toEqual({ type: "ready" });
    const page = document.getElementById("root")!;
    expect(page.querySelector("h1")?.textContent).toBe("Report");
    expect(page.querySelector("h1")?.hasAttribute("onclick")).toBe(false);
    expect(page.querySelector("script")).toBeNull();
    expect([...page.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual([
      null,
      null,
    ]);
    expect([...page.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      null,
      "data:image/png;base64,AA==",
    ]);
  });
});
