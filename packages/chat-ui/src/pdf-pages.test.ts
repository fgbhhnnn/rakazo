// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PdfJsLike, renderPdfPages } from "./pdf-pages";

function fakePdfJs(numPages: number, fail?: Error) {
  const rendered: number[] = [];
  const destroy = vi.fn(async () => {});
  const getDocument = vi.fn((_options: unknown) => ({
    promise: fail
      ? Promise.reject(fail)
      : Promise.resolve({
          numPages,
          destroy: async () => {},
          getPage: async (pageNumber: number) => ({
            getViewport: ({ scale }: { scale: number }) => ({
              width: 600 * scale,
              height: 800 * scale,
            }),
            render: () => {
              rendered.push(pageNumber);
              return { promise: Promise.resolve(), cancel() {} };
            },
            cleanup() {},
          }),
        }),
    destroy,
  }));
  return { pdfjs: { getDocument } as unknown as PdfJsLike, getDocument, rendered, destroy };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("renderPdfPages", () => {
  it("opens the document safely and draws every page as a labelled canvas", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    const { pdfjs, getDocument, rendered } = fakePdfJs(3);
    const container = document.createElement("div");
    const bytes = new Uint8Array([37, 80, 68, 70]);
    renderPdfPages(pdfjs, container, bytes);
    for (let i = 0; i < 10; i++) await flush();
    const options = getDocument.mock.calls[0]![0] as {
      data: Uint8Array;
      isEvalSupported: boolean;
      enableXfa: boolean;
    };
    expect(options).toMatchObject({ isEvalSupported: false, enableXfa: false });
    expect(options.data).not.toBe(bytes);
    expect([...options.data]).toEqual([...bytes]);
    expect(rendered).toEqual([1, 2, 3]);
    const pages = [...container.querySelectorAll("[data-page]")];
    expect(pages.map((page) => page.getAttribute("aria-label"))).toEqual([
      "Page 1 of 3",
      "Page 2 of 3",
      "Page 3 of 3",
    ]);
    expect(container.querySelectorAll("canvas")).toHaveLength(3);
  });

  it("renders pages only as they come near the viewport", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    let callback: ((entries: { isIntersecting: boolean; target: Element }[]) => void) | undefined;
    const observed: Element[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          cb: typeof callback,
          readonly init: IntersectionObserverInit,
        ) {
          callback = cb;
          expect(init.rootMargin).toBe("800px 0px");
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect = disconnect;
      },
    );
    const { pdfjs, rendered, destroy } = fakePdfJs(5);
    const container = document.createElement("div");
    const stop = renderPdfPages(pdfjs, container, new Uint8Array([1]));
    for (let i = 0; i < 5; i++) await flush();
    expect(observed).toHaveLength(5);
    expect(rendered).toEqual([]);
    callback!([
      { isIntersecting: true, target: observed[1]! },
      { isIntersecting: false, target: observed[4]! },
    ]);
    for (let i = 0; i < 5; i++) await flush();
    expect(rendered).toEqual([2]);
    stop();
    expect(disconnect).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalled();
  });

  it("reports a broken file to the caller", async () => {
    const onError = vi.fn();
    const { pdfjs } = fakePdfJs(0, new Error("Invalid PDF structure."));
    renderPdfPages(pdfjs, document.createElement("div"), new Uint8Array([1]), { onError });
    await flush();
    expect(onError).toHaveBeenCalledWith(new Error("Invalid PDF structure."));
  });
});
