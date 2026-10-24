import { useLingui } from "@lingui/react/macro";
import { renderPdfPages } from "@rakazo/chat-ui/pdf-pages";
import { Spinner } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { loadPdfJs } from "../lib/pdfjs";

/**
 * In-app PDF viewer (pdf.js, lazily loaded). A blob: iframe relied on the browser's PDF plugin,
 * which the app CSP (object-src 'none') blocks and mobile browsers do not have.
 */
export function PdfViewer({ bytes, title }: { bytes: Uint8Array; title: string }) {
  const { t } = useLingui();
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    let stop = () => {};
    let cancelled = false;
    setState("loading");
    void loadPdfJs()
      .then((pdfjs) => {
        if (cancelled) return;
        stop = renderPdfPages(pdfjs, target, bytes, { onError: () => setState("error") });
        setState((current) => (current === "error" ? current : "ready"));
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [bytes]);

  return (
    <section className="relative h-full w-full overflow-y-auto bg-muted" aria-label={title}>
      {state === "loading" ? (
        <div className="absolute inset-0 grid place-items-center text-muted-foreground">
          <Spinner aria-label={t`Loading preview…`} />
        </div>
      ) : state === "error" ? (
        <div className="m-5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
          {t`Could not open this PDF. Download it to view it.`}
        </div>
      ) : null}
      <div ref={container} data-testid="pdf-pages" />
    </section>
  );
}
