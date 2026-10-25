import { useLingui } from "@lingui/react/macro";
import { Dialog, DialogContent } from "@rakazo/ui-web";
import { FileText } from "lucide-react";
import { useRef, useState } from "react";
import { PageReader } from "./PageReader";

type PageCardProps = {
  pageId: string;
  title: string;
  snippet?: string;
  className?: string;
};

/** A bot's report or plan in chat: the title and a preview, opening the full page. */
export function PageCard({ pageId, title, snippet, className }: PageCardProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={openButton}
        type="button"
        aria-label={t`Open page ${title}`}
        onClick={() => setOpen(true)}
        className={
          className ??
          "flex w-[min(420px,100%)] min-w-[280px] items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-left text-foreground hover:bg-accent"
        }
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
          <FileText size={19} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] leading-5 font-semibold">{title}</span>
          {snippet ? (
            <span className="mt-1 line-clamp-2 block text-[13px] leading-5 text-muted-foreground">
              {snippet}
            </span>
          ) : null}
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          initialFocus={closeButton}
          finalFocus={openButton}
          className="flex h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 ring-0 sm:h-[min(94vh,1100px)] sm:w-[min(1180px,96vw)] sm:max-w-none sm:rounded-xl sm:ring-1"
        >
          <PageReader pageId={pageId} initialTitle={title} inDialog closeButtonRef={closeButton} />
        </DialogContent>
      </Dialog>
    </>
  );
}
