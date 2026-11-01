import { renderPdfPages } from "@rakazo/chat-ui/pdf-pages";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { hostViewer } from "./host";

// pdf.js runs its parser on the page's thread: the viewer is one offline file with no worker URL.
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

hostViewer((bytes, _request, root, fail) => {
  renderPdfPages(pdfjs as never, root, bytes, { gap: 8, onError: fail });
});
