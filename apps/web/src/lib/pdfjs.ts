import type { PdfJsLike } from "@rakazo/chat-ui/pdf-pages";

let loaded: Promise<PdfJsLike> | undefined;

/** pdf.js in its own chunk, fetched the first time a PDF is opened; the worker is same-origin. */
export function loadPdfJs(): Promise<PdfJsLike> {
  loaded ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs as unknown as PdfJsLike;
  });
  void loaded.catch(() => {
    loaded = undefined;
  });
  return loaded;
}
