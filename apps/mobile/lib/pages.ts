import type { Page, PageBlockMeta, PageSummary } from "@rakazo/contracts";
import { pagePath } from "@rakazo/contracts";
import { currentApiBase, rpc } from "./api";

export function listPages(input: { botId?: string; limit?: number } = {}): Promise<PageSummary[]> {
  return rpc<PageSummary[]>("pages/list", input);
}

export function getPage(pageId: string): Promise<Page> {
  return rpc<Page>("pages/get", { pageId });
}

/** Saves the owner's edit as the next version; a newer saved version rejects it. */
export function savePage(input: {
  pageId: string;
  markdown: string;
  baseVersion: number;
}): Promise<Page> {
  return rpc<Page>("pages/update", input);
}

/** The signed-in link to a page on this server; it opens only for its owner. */
export function pageShareLink(pageId: string, apiBase: string = currentApiBase()): string {
  return `${apiBase.replace(/\/+$/, "")}${pagePath(pageId)}`;
}

/** Where a page card in chat or the Pages list opens. */
export function pageRoute(page: { pageId: string; title: string }) {
  return { pathname: "/page" as const, params: { pageId: page.pageId, title: page.title } };
}

/** A thread file block that is a Page, read as card fields; anything else is not a page. */
export function pageCardFromBlock(block: {
  kind: string;
  name?: string;
  page?: PageBlockMeta;
}): { pageId: string; title: string; snippet?: string } | null {
  if (block.kind !== "file" || !block.page) return null;
  return { pageId: block.page.pageId, title: block.name ?? "", snippet: block.page.snippet };
}

/** Whether a failed save lost to a newer version of the page. */
export function isPageConflict(error: unknown): boolean {
  const value = error as { code?: unknown; status?: unknown } | null;
  return value?.code === "CONFLICT" || value?.status === 409;
}

/** The scroll offset that puts a section's heading just under the top edge. */
export function sectionScrollY(
  offsets: ReadonlyMap<string, number>,
  sectionId: string,
  bodyTop: number,
  margin = 12,
): number | null {
  const offset = offsets.get(sectionId);
  if (offset === undefined) return null;
  return Math.max(0, bodyTop + offset - margin);
}
