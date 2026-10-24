import { useLingui } from "@lingui/react/macro";
import { decodeFileText, fileKindOf, filePreviewMarkdown } from "@rakazo/chat-ui/file-kinds";
import { docxHtml, workbookMarkdown } from "@rakazo/chat-ui/office-preview";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { Spinner } from "@rakazo/ui-web";
import { useEffect, useMemo, useState } from "react";
import { PdfViewer } from "./PdfViewer";
import { SandboxedHtmlViewer } from "./SandboxedHtmlViewer";

type FileRef = { name: string; mimeType: string };

/** The in-app view of a file's bytes; office libraries load only when such a file is opened. */
export function FileViewerBody({ bytes, name, mimeType }: FileRef & { bytes: Uint8Array }) {
  const kind = fileKindOf({ name, mimeType });
  if (kind.viewer === "pdf") return <PdfViewer bytes={bytes} title={name} />;
  if (kind.viewer === "spreadsheet") {
    return (
      <Converted
        bytes={bytes}
        convert={async (data) => workbookMarkdown(await import("xlsx"), data)}
        render={(markdown) => <MarkdownPane markdown={markdown} />}
      />
    );
  }
  if (kind.viewer === "docx") {
    return (
      <Converted
        bytes={bytes}
        convert={async (data) => docxHtml((await import("mammoth")).default, data)}
        render={(html) => <SandboxedHtmlViewer html={html} title={name} />}
      />
    );
  }
  return <TextPane bytes={bytes} name={name} mimeType={mimeType} />;
}

function TextPane({ bytes, name, mimeType }: FileRef & { bytes: Uint8Array }) {
  const markdown = useMemo(
    () => filePreviewMarkdown(fileKindOf({ name, mimeType }), decodeFileText(bytes)),
    [bytes, name, mimeType],
  );
  return <MarkdownPane markdown={markdown} />;
}

function MarkdownPane({ markdown }: { markdown: string }) {
  return (
    <div className="h-full overflow-auto bg-background" data-testid="file-viewer-markdown">
      <article className="mx-auto w-full max-w-[1100px] px-6 py-8 text-[15px] leading-7 text-foreground sm:px-10">
        <ChatMarkdown>{markdown}</ChatMarkdown>
      </article>
    </div>
  );
}

function Converted({
  bytes,
  convert,
  render,
}: {
  bytes: Uint8Array;
  convert: (bytes: Uint8Array) => Promise<string>;
  render: (output: string) => React.ReactNode;
}) {
  const { t } = useLingui();
  const [state, setState] = useState<
    { status: "loading" | "error" } | { status: "ready"; output: string }
  >({
    status: "loading",
  });
  // `convert` is a fresh closure each render; the bytes decide what is shown.
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void convert(bytes)
      .then((output) => !cancelled && setState({ status: "ready", output }))
      .catch(() => !cancelled && setState({ status: "error" }));
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  if (state.status === "ready") return <>{render(state.output)}</>;
  if (state.status === "error") {
    return (
      <div className="m-5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
        {t`Could not preview this file. Download it to open it.`}
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center text-muted-foreground">
      <Spinner aria-label={t`Loading preview…`} />
    </div>
  );
}
