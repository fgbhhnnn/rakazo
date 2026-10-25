import { Trans } from "@lingui/react/macro";
import type { PageSummary } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { PageCard } from "./PageCard";

const SHELF_LIMIT = 30;

/** The reports and plans bots wrote as pages, newest first; hidden when there are none. */
export function PagesShelf({ botId }: { botId?: string }) {
  const [pages, setPages] = useState<PageSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    setPages([]);
    void rpc.pages
      .list({ botId, limit: SHELF_LIMIT })
      .then((items) => {
        if (!cancelled) setPages(items);
      })
      // The file list below still shows every page's markdown file.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [botId]);

  if (pages.length === 0) return null;
  return (
    <section className="shrink-0 border-b border-border px-4 py-4 md:px-6">
      <h2 className="mb-3 text-[13px] font-semibold text-muted-foreground">
        <Trans>Pages</Trans>
      </h2>
      <ul className="flex gap-3 overflow-x-auto pb-1">
        {pages.map((page) => (
          <li key={page.id} className="shrink-0">
            <PageCard
              pageId={page.id}
              title={page.title}
              snippet={page.snippet}
              className="flex h-full w-[300px] items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-left text-foreground hover:bg-accent"
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
