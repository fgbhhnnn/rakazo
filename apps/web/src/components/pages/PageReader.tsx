import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { Page } from "@rakazo/contracts";
import { pageLayout } from "@rakazo/contracts";
import { Button, cn, DialogClose, DialogTitle, Spinner, Textarea } from "@rakazo/ui-web";
import { Check, Link2, Pencil, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { IconTooltip } from "../IconTooltip";
import { pageAnchorId, pageLink } from "./page-anchors";
import "./page-reader.css";

type PageReaderProps = {
  pageId: string;
  /** Shown while the page loads, from the chat card. */
  initialTitle?: string;
  /** Inside a dialog the title and close button use the dialog's own parts. */
  inDialog?: boolean;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  onClose?: () => void;
  /** A section to open at, from the link's hash. */
  initialSection?: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; page: Page }
  | { status: "error"; message: string };

function isConflict(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "CONFLICT";
}

export function PageReader({
  pageId,
  initialTitle,
  inDialog = false,
  closeButtonRef,
  onClose,
  initialSection,
}: PageReaderProps) {
  const { t, i18n } = useLingui();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void rpc.pages
      .get({ pageId })
      .then((page) => {
        if (!cancelled) setState({ status: "ready", page });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setState({ status: "error", message: errorText(error, t`Could not open this page.`) });
      });
    return () => {
      cancelled = true;
    };
  }, [pageId, t]);

  const page = state.status === "ready" ? state.page : null;
  const layout = useMemo(() => (page ? pageLayout(page.markdown, page.title) : null), [page]);
  const title = page?.title ?? initialTitle ?? "";
  const updated = page
    ? i18n.date(page.updatedAt, { dateStyle: "medium", timeStyle: "short" })
    : "";

  useEffect(() => {
    if (!initialSection || !layout || draft !== null) return;
    document.getElementById(pageAnchorId(initialSection))?.scrollIntoView({ block: "start" });
  }, [initialSection, layout, draft]);

  // Highlights the contents entry for the section being read.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !layout || draft !== null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        const first = visible.sort(
          (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
        )[0];
        if (first) setActiveSection(first.target.getAttribute("data-section-id"));
      },
      { root, rootMargin: "0px 0px -70% 0px" },
    );
    for (const element of root.querySelectorAll("[data-section-id]")) observer.observe(element);
    return () => observer.disconnect();
  }, [layout, draft]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  function jumpTo(sectionId: string) {
    setActiveSection(sectionId);
    document
      .getElementById(pageAnchorId(sectionId))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function copyLink() {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(pageLink(pageId, window.location.origin));
      setCopied(true);
    } catch {
      setCopyError(true);
    }
  }

  async function save() {
    if (!page || draft === null) return;
    if (!draft.trim()) {
      setSaveError(t`A page can't be empty.`);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await rpc.pages.update({
        pageId,
        markdown: draft,
        baseVersion: page.version,
      });
      setState({ status: "ready", page: saved });
      setDraft(null);
    } catch (error) {
      setSaveError(
        isConflict(error)
          ? t`This page changed since you opened it. Close it and open it again to edit the latest version.`
          : errorText(error, t`Could not save this page.`),
      );
    } finally {
      setSaving(false);
    }
  }

  const closeLabel = t`Close page`;
  const close: ReactNode = inDialog ? (
    <DialogClose
      ref={closeButtonRef}
      aria-label={closeLabel}
      render={
        <Button variant="ghost" size="icon-lg" className="rounded-full text-muted-foreground" />
      }
    >
      <X />
    </DialogClose>
  ) : onClose ? (
    <Button
      ref={closeButtonRef}
      variant="ghost"
      size="icon-lg"
      className="rounded-full text-muted-foreground"
      aria-label={closeLabel}
      onClick={onClose}
    >
      <X />
    </Button>
  ) : null;

  const headerTitle = inDialog ? (
    <DialogTitle className="min-w-0 flex-1 truncate text-[14px] leading-5 font-medium text-muted-foreground">
      {title}
    </DialogTitle>
  ) : (
    <span className="min-w-0 flex-1 truncate text-[14px] leading-5 font-medium text-muted-foreground">
      {title}
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-3 sm:px-5">
        {headerTitle}
        {draft !== null ? (
          <>
            <Button variant="ghost" size="sm" disabled={saving} onClick={() => setDraft(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner /> : null}
              <Trans>Save</Trans>
            </Button>
          </>
        ) : page ? (
          <>
            <IconTooltip label={t`Edit page`}>
              <Button
                variant="ghost"
                size="icon-lg"
                className="rounded-full text-muted-foreground"
                aria-label={t`Edit page`}
                onClick={() => {
                  setSaveError(null);
                  setDraft(page.markdown);
                }}
              >
                <Pencil />
              </Button>
            </IconTooltip>
            <IconTooltip label={copied ? t`Link copied` : t`Copy link`}>
              <Button
                variant="ghost"
                size="icon-lg"
                className="rounded-full text-muted-foreground"
                aria-label={copied ? t`Link copied` : t`Copy link`}
                onClick={() => void copyLink()}
              >
                {copied ? <Check /> : <Link2 />}
              </Button>
            </IconTooltip>
          </>
        ) : null}
        {close}
      </header>
      {copyError ? (
        <p role="alert" className="shrink-0 px-5 pt-3 text-[13px] text-destructive">
          <Trans>Could not copy the link.</Trans>
        </p>
      ) : null}
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" ? (
          <div className="absolute inset-0 grid place-items-center text-muted-foreground">
            <Spinner aria-label={t`Loading page…`} />
          </div>
        ) : state.status === "error" ? (
          <div className="m-5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive">
            {state.message}
          </div>
        ) : draft !== null ? (
          <div className="mx-auto flex h-full w-full max-w-[860px] flex-col gap-3 px-4 py-5 sm:px-8">
            {saveError ? (
              <p role="alert" className="text-[13px] text-destructive">
                {saveError}
              </p>
            ) : null}
            <Textarea
              aria-label={t`Page markdown`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-0 flex-1 resize-none [field-sizing:fixed] font-mono text-[13.5px] leading-6"
              spellCheck
            />
          </div>
        ) : layout && page ? (
          <div className="mx-auto flex w-full max-w-[1120px] gap-14 px-6 pt-10 pb-24 sm:px-10 lg:pt-14">
            <article className="min-w-0 max-w-[720px] flex-1">
              <h1 className="text-[30px] leading-[1.2] font-semibold tracking-tight text-foreground sm:text-[34px]">
                {page.title}
              </h1>
              <p className="mt-2 text-[13px] text-muted-foreground">
                <Trans>Updated {updated}</Trans>
              </p>
              {layout.contents.length > 1 ? (
                <PageContents
                  className="mt-6 rounded-xl border border-border bg-card px-4 py-3 lg:hidden"
                  contents={layout.contents}
                  activeSection={activeSection}
                  onJump={jumpTo}
                />
              ) : null}
              <div className="rk-page-body mt-8">
                {layout.intro ? (
                  <div>
                    <ChatMarkdown>{layout.intro}</ChatMarkdown>
                  </div>
                ) : null}
                {layout.sections.map((section) => (
                  <section
                    key={section.id}
                    id={pageAnchorId(section.id)}
                    data-section-id={section.id}
                    className="scroll-mt-6"
                  >
                    <ChatMarkdown>{section.markdown}</ChatMarkdown>
                  </section>
                ))}
              </div>
            </article>
            {layout.contents.length > 1 ? (
              <aside className="hidden w-56 shrink-0 lg:block">
                <PageContents
                  className="sticky top-0"
                  contents={layout.contents}
                  activeSection={activeSection}
                  onJump={jumpTo}
                />
              </aside>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PageContents({
  contents,
  activeSection,
  onJump,
  className,
}: {
  contents: Array<{ id: string; title: string; depth: number }>;
  activeSection: string | null;
  onJump: (sectionId: string) => void;
  className?: string;
}) {
  const { t } = useLingui();
  return (
    <nav aria-label={t`On this page`} className={className}>
      <p className="mb-2 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">
        <Trans>On this page</Trans>
      </p>
      <ul className="space-y-0.5">
        {contents.map((section) => (
          <li key={section.id} style={{ paddingInlineStart: `${section.depth * 12}px` }}>
            <a
              href={`#${section.id}`}
              aria-current={activeSection === section.id ? "location" : undefined}
              onClick={(event) => {
                event.preventDefault();
                onJump(section.id);
              }}
              className={cn(
                "block truncate rounded-md px-2 py-1 text-[13px] leading-5 text-muted-foreground hover:bg-accent hover:text-foreground",
                activeSection === section.id && "font-medium text-foreground",
              )}
            >
              {section.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
