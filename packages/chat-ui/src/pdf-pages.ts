/**
 * Renders a PDF into a scrolling column of canvases with pdf.js, page by page as pages near the
 * viewport. Shared by the web viewer and the mobile WebView viewer (iOS and Android alike), so a
 * PDF looks the same everywhere and never depends on a browser's built-in PDF plugin (blocked by
 * the app's CSP, missing on mobile browsers and Android WebView). The caller supplies pdf.js.
 */

interface Viewport {
  width: number;
  height: number;
}
interface PdfPage {
  getViewport(options: { scale: number }): Viewport;
  render(options: {
    canvas: HTMLCanvasElement;
    canvasContext: CanvasRenderingContext2D;
    viewport: Viewport;
  }): { promise: Promise<void>; cancel(): void };
  cleanup(): void;
}
interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
export interface PdfJsLike {
  getDocument(options: {
    data: Uint8Array;
    isEvalSupported: boolean;
    enableXfa: boolean;
    disableAutoFetch?: boolean;
  }): { promise: Promise<PdfDocument>; destroy(): Promise<void> };
}

export interface PdfPagesOptions {
  /** Gap between pages and around the column, in CSS pixels. */
  gap?: number;
  pageBackground?: string;
  onError?: (error: unknown) => void;
}

/** Renders `bytes` into `container`; the returned function stops rendering and frees the document. */
export function renderPdfPages(
  pdfjs: PdfJsLike,
  container: HTMLElement,
  bytes: Uint8Array,
  options: PdfPagesOptions = {},
): () => void {
  const gap = options.gap ?? 12;
  let stopped = false;
  let observer: IntersectionObserver | undefined;
  // pdf.js transfers the buffer to its worker; keep the caller's bytes intact.
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    // Never compile font programs with eval (CVE-2024-4367) and never run XFA forms.
    isEvalSupported: false,
    enableXfa: false,
  });
  const column = document.createElement("div");
  column.style.cssText = `display:flex;flex-direction:column;align-items:center;gap:${gap}px;padding:${gap}px;box-sizing:border-box;width:100%`;
  container.replaceChildren(column);

  void (async () => {
    const pdf = await task.promise;
    if (stopped) return;
    const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const slots = Array.from({ length: pdf.numPages }, (_, index) => {
      const slot = document.createElement("div");
      slot.dataset.page = String(index + 1);
      slot.setAttribute("role", "img");
      slot.setAttribute("aria-label", `Page ${index + 1} of ${pdf.numPages}`);
      slot.style.cssText = `width:100%;max-width:${Math.round(first.width * 1.5)}px;aspect-ratio:${first.width}/${first.height};background:${options.pageBackground ?? "#fff"};box-shadow:0 1px 3px rgba(0,0,0,.18);position:relative`;
      column.append(slot);
      return slot;
    });
    const rendered = new Set<number>();
    const render = async (slot: HTMLElement) => {
      const pageNumber = Number(slot.dataset.page);
      if (rendered.has(pageNumber) || stopped) return;
      rendered.add(pageNumber);
      const page = await pdf.getPage(pageNumber);
      if (stopped) return;
      const natural = page.getViewport({ scale: 1 });
      slot.style.aspectRatio = `${natural.width}/${natural.height}`;
      const density = Math.min(globalThis.devicePixelRatio || 1, 3);
      const width = Math.max(slot.clientWidth, 320);
      const viewport = page.getViewport({ scale: (width / natural.width) * density });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.cssText = "display:block;width:100%;height:100%";
      const context = canvas.getContext("2d");
      if (!context) return;
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      if (stopped) return;
      slot.replaceChildren(canvas);
      page.cleanup();
    };
    if (typeof IntersectionObserver === "undefined") {
      for (const slot of slots) await render(slot);
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) void render(entry.target as HTMLElement).catch(options.onError);
        }
      },
      { root: null, rootMargin: "800px 0px" },
    );
    for (const slot of slots) observer.observe(slot);
  })().catch((error: unknown) => {
    if (!stopped) options.onError?.(error);
  });

  return () => {
    stopped = true;
    observer?.disconnect();
    void task.destroy();
  };
}
