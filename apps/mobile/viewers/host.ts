/**
 * Page side of the mobile document viewers: a self-contained HTML asset (no network, no app
 * session) that the app opens in a WebView and hands a file to with `rakazoOpen(...)`. It answers
 * through ReactNativeWebView.postMessage with "loaded", "ready" or "error".
 */

export type ViewerKind = "pdf" | "spreadsheet" | "docx";
export interface ViewerRequest {
  viewer: ViewerKind;
  name: string;
  base64: string;
}
export type ViewerMessage =
  | { type: "loaded" }
  | { type: "ready" }
  | { type: "error"; message: string };

type ViewerWindow = Window & {
  ReactNativeWebView?: { postMessage(message: string): void };
  rakazoOpen?: (request: ViewerRequest) => Promise<void>;
};

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function hostViewer(
  render: (
    bytes: Uint8Array,
    request: ViewerRequest,
    root: HTMLElement,
    fail: (error: unknown) => void,
  ) => Promise<void> | void,
): void {
  const view = window as ViewerWindow;
  const post = (message: ViewerMessage) =>
    view.ReactNativeWebView?.postMessage(JSON.stringify(message));
  const fail = (error: unknown) =>
    post({ type: "error", message: error instanceof Error ? error.message : String(error) });
  // Links inside a document never navigate the viewer (the app also refuses any navigation).
  document.addEventListener("click", (event) => {
    if ((event.target as Element | null)?.closest?.("a")) event.preventDefault();
  });
  view.rakazoOpen = async (request) => {
    const root = document.getElementById("root")!;
    try {
      await render(base64ToBytes(request.base64), request, root, fail);
      post({ type: "ready" });
    } catch (error) {
      fail(error);
    }
  };
  post({ type: "loaded" });
}
