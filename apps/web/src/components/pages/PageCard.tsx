import { Trans, useLingui } from "@lingui/react/macro";
import { Dialog, DialogContent } from "@rakazo/ui-web";
import { FileText } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelativeTime } from "../../lib/relative-time";
import { PageFrame } from "./PageFrame";
import { PageReader } from "./PageReader";
import { PageTileIcon } from "./page-icon";

/** Pages draw at desktop width and shrink into the card, so a preview reads like the page. */
// Large enough that the preview's body text stays readable, not grey texture.
const PREVIEW_SCALE = 0.75;
const PREVIEW_ASPECT = 630 / 1200;

/** The nearest ancestor that scrolls, so "near view" is measured along the chat, not the window. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
  }
  return null;
}

/** Previews kept running after they leave view, so scrolling back shows them drawn. */
const LIVE_PREVIEWS = 24;
const livePreviews = new Map<object, { near: boolean; drop: () => void }>();

/**
 * The page's top, drawn live at `width / PREVIEW_SCALE` and scaled down. It mounts once the card
 * scrolls near view and keeps running until newer previews push it out of the live set, so a
 * long chat runs a bounded number of pages.
 */
function PagePreview({
  document,
  title,
  failed,
}: {
  document: string | null;
  title: string;
  failed: boolean;
}) {
  const { t } = useLingui();
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [live, setLive] = useState(false);
  const [drawn, setDrawn] = useState(false);
  const onDrawn = useCallback(() => setDrawn(true), []);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const resize = new ResizeObserver(([entry]) =>
      setSize({ width: entry?.contentRect.width ?? 0, height: entry?.contentRect.height ?? 0 }),
    );
    resize.observe(element);
    const key = {};
    const drop = () => {
      livePreviews.delete(key);
      setLive(false);
      setDrawn(false);
    };
    const near = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (!entry.isIntersecting) {
          const preview = livePreviews.get(key);
          if (preview) preview.near = false;
          return;
        }
        livePreviews.delete(key);
        livePreviews.set(key, { near: true, drop });
        setLive(true);
        let over = livePreviews.size - LIVE_PREVIEWS;
        for (const [other, preview] of livePreviews) {
          if (over <= 0) break;
          if (other === key || preview.near) continue;
          preview.drop();
          over--;
        }
      },
      { root: scrollParent(element), rootMargin: "400px 0px" },
    );
    near.observe(element);
    return () => {
      resize.disconnect();
      near.disconnect();
      livePreviews.delete(key);
    };
  }, []);
  return (
    <div
      ref={box}
      aria-hidden="true"
      // A touch tablet card shows at least 335px of page however narrow the chat makes it.
      className="pointer-events-none relative w-full overflow-hidden bg-card pointer-coarse:min-[900px]:min-h-[335px]"
      style={{ aspectRatio: `${1 / PREVIEW_ASPECT}` }}
    >
      {live && document !== null && size.width > 0 ? (
        <div
          inert
          // On a touch tablet the preview starts 13px further up the page.
          className="absolute top-0 left-0 origin-top-left pointer-coarse:min-[900px]:-top-[13px]"
          style={{
            width: size.width / PREVIEW_SCALE,
            // Taller than the box by that upward shift, so no blank strip shows below.
            height: (size.height + 13) / PREVIEW_SCALE,
            transform: `scale(${PREVIEW_SCALE})`,
          }}
        >
          <PageFrame document={document} title={title} onHeight={onDrawn} />
        </div>
      ) : null}
      {drawn ? null : (
        // The page's shape until it draws, so the card never sits empty; still once it can't load.
        <div
          className={`absolute inset-0 flex flex-col gap-3 bg-card px-6 pt-6 ${failed ? "" : "motion-safe:animate-pulse"}`}
        >
          <div className="h-5 w-2/5 rounded-[6px] bg-foreground/[0.06]" />
          <div className="h-3 w-3/5 rounded-[5px] bg-foreground/[0.05]" />
          <div className="mt-2 grid grid-cols-3 gap-2">
            <div className="h-12 rounded-sm bg-foreground/[0.05]" />
            <div className="h-12 rounded-sm bg-foreground/[0.05]" />
            <div className="h-12 rounded-sm bg-foreground/[0.05]" />
          </div>
          {failed ? (
            <p className="text-center text-muted-foreground text-body">{t`This page couldn't load`}</p>
          ) : null}
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 h-[100px] bg-linear-to-b from-transparent to-card" />
    </div>
  );
}

/** A page in the chat: its live top and a footer naming it. The whole card opens the page. */
function PagePreviewCard({
  title,
  document,
  onOpen,
  updated = false,
  updatedAt,
  shared = false,
  failed = false,
}: {
  title: string;
  /** When the page last changed, said under its title. */
  updatedAt?: string;
  /** Anyone with the link can open it. */
  shared?: boolean;
  document: string | null;
  /** The page could not be read, so its preview stops looking like it is loading. */
  failed?: boolean;
  /** Absent once the page is deleted: the card stays in the chat and opens nothing. */
  onOpen?: () => void;
  /** A newer version of this page appears further down the chat. */
  updated?: boolean;
}) {
  const { t } = useLingui();
  const when = updatedAt ? formatRelativeTime(updatedAt) : "";
  return (
    <div
      data-testid="page-card"
      data-deleted={onOpen === undefined || undefined}
      className="relative w-full max-w-[561px] overflow-hidden pointer-coarse:min-[900px]:max-w-[639px] rounded-[24px] bg-card has-focus-visible:ring-2 has-focus-visible:ring-ring data-deleted:bg-transparent data-deleted:opacity-70"
    >
      {onOpen ? <PagePreview document={document} title={title} failed={failed} /> : null}
      <div className="flex h-[73px] items-center gap-[14px] border-t border-foreground/[0.04] px-5">
        <PageTileIcon />
        <div className="min-w-0">
          <div className="relative top-[1px] truncate text-body-lg leading-[21px] text-foreground">
            {title}
          </div>
          <div className="truncate text-body text-muted-foreground">
            {onOpen === undefined ? (
              <Trans>Page · Deleted</Trans>
            ) : updated ? (
              <Trans>Page · Updated below</Trans>
            ) : when ? (
              shared ? (
                <Trans>Page · Shared · {when}</Trans>
              ) : (
                <Trans>Page · {when}</Trans>
              )
            ) : (
              <Trans>Page</Trans>
            )}
          </div>
        </div>
      </div>
      {onOpen ? (
        <button
          type="button"
          aria-label={t`Open ${title}`}
          onClick={onOpen}
          className="absolute inset-0 rounded-[24px] outline-none hover:bg-accent/10"
        />
      ) : null}
    </div>
  );
}

type MarkdownPageCardProps = {
  pageId: string;
  title: string;
  snippet?: string;
  className?: string;
};

/** Chat previews and the Markdown reports on the artifact shelf open their own page viewers. */
export function PageCard(props: Parameters<typeof PagePreviewCard>[0] | MarkdownPageCardProps) {
  return "pageId" in props ? <MarkdownPageCard {...props} /> : <PagePreviewCard {...props} />;
}

/** A bot's report or plan in chat: the title and a preview, opening the full page. */
function MarkdownPageCard({ pageId, title, snippet, className }: MarkdownPageCardProps) {
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
          "flex w-[min(420px,100%)] min-w-[280px] items-start gap-3 rounded-2xl bg-card px-4 py-3.5 text-left text-foreground hover:bg-accent"
        }
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
          <FileText size={19} strokeWidth={1.8} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body leading-5 font-semibold">{title}</span>
          {snippet ? (
            <span className="mt-1 line-clamp-2 block text-body-sm leading-5 text-muted-foreground">
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
