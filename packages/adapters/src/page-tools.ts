import type { ConnectorTool } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import {
  applyPageEdits,
  PAGE_EDITS_MAX,
  PAGE_MARKDOWN_MAX_LENGTH,
  PAGE_TITLE_MAX_LENGTH,
  type PageEdit,
} from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import { createPage, type PageDeps, PageError, readPage, updatePage } from "./pages.js";

export const WRITE_PAGE_TOOL = "write_page";
export const EDIT_PAGE_TOOL = "edit_page";
export const READ_PAGE_TOOL = "read_page";
export const PAGE_TOOL_NAMES: ReadonlySet<string> = new Set([
  WRITE_PAGE_TOOL,
  EDIT_PAGE_TOOL,
  READ_PAGE_TOOL,
]);

export const pageTools: ConnectorTool[] = [
  {
    name: WRITE_PAGE_TOOL,
    description: `Write a new Page: a clean, editable document the user opens from a card in this chat. Use it for reports, plans, memos, trackers and other material meant to be read, instead of a long chat message or a .md file. Body is GitHub markdown (headings become the page's contents list; tables and \`\`\`mermaid diagrams render). Do not repeat the title as the first heading. One page per subject; to change an existing page use ${EDIT_PAGE_TOOL}. Then tell the user in one or two lines what the page covers.`,
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: `Short page title (max ${PAGE_TITLE_MAX_LENGTH} characters).`,
        },
        markdown: {
          type: "string",
          description: `The page body in markdown (max ${PAGE_MARKDOWN_MAX_LENGTH} characters).`,
        },
      },
      required: ["title", "markdown"],
    },
  },
  {
    name: EDIT_PAGE_TOOL,
    description: `Change an existing Page (by page_id from a [page: …] card or ${WRITE_PAGE_TOOL}). The same page gets a new version and the user sees the updated card. Pass edits (exact find/replace pairs, each find must match once) for small changes, or markdown to replace the whole body. Call ${READ_PAGE_TOOL} first when you do not have the current text.`,
    inputSchema: {
      type: "object",
      properties: {
        page_id: { type: "string" },
        edits: {
          type: "array",
          description: `Up to ${PAGE_EDITS_MAX} find/replace pairs applied in order.`,
          items: {
            type: "object",
            properties: { find: { type: "string" }, replace: { type: "string" } },
            required: ["find", "replace"],
          },
        },
        markdown: { type: "string", description: "The full new body, instead of edits." },
      },
      required: ["page_id"],
    },
  },
  {
    name: READ_PAGE_TOOL,
    description:
      "Read the current markdown of a Page by page_id (including changes the user made by hand).",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string" } },
      required: ["page_id"],
    },
  },
];

/** System guidance for a bot that can write pages. */
export const PAGE_GUIDANCE = `Reports, plans, memos, trackers and other material the user will read or keep go in a Page: call ${WRITE_PAGE_TOOL}, then reply with only one or two lines saying what it covers. Never also paste the content in chat or attach it as a .md file. Short answers stay in chat. When the user asks to change a page, use ${EDIT_PAGE_TOOL} on that page (its page_id is on the [page: …] card) rather than writing a new one.`;

/** System guidance for a dispatcher, which has no page tools itself. */
export const PAGE_DISPATCH_GUIDANCE = `Reports, plans, memos and trackers reach the user as Pages: ask the worker to write one with ${WRITE_PAGE_TOOL}; it appears in this chat as a card on its own. To change a page, give the worker its page_id (from the [page: …] card) and ask it to use ${EDIT_PAGE_TOOL}. Do not paste a page's content into chat.`;

export type PageToolScope = {
  spaceId: string;
  userId: string;
  /** The bot pages are attributed to: a hidden worker's main bot. */
  botId: string;
  groupId?: string | null;
  runId: string;
  operationId: string;
  secrets?: string[];
};

export type PageToolOutcome = { result: Record<string, unknown>; block?: MessageBlock };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pageEdits(value: unknown): PageEdit[] | { error: string } {
  if (!Array.isArray(value)) return { error: "edits must be a list of {find, replace}" };
  if (value.length > PAGE_EDITS_MAX) return { error: `at most ${PAGE_EDITS_MAX} edits per call` };
  const edits: PageEdit[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return { error: "each edit needs find and replace" };
    const record = item as Record<string, unknown>;
    if (typeof record.find !== "string" || typeof record.replace !== "string")
      return { error: "each edit needs find and replace strings" };
    edits.push({ find: record.find, replace: record.replace });
  }
  return edits;
}

/** Runs write_page, edit_page or read_page. Errors come back as `{ error }` for the model. */
export async function runPageTool(
  deps: PageDeps,
  scope: PageToolScope,
  name: string,
  args: Record<string, unknown>,
): Promise<PageToolOutcome> {
  const clean = (markdown: string) => redactSecrets(markdown, scope.secrets ?? []);
  const owner = { spaceId: scope.spaceId, userId: scope.userId, botIds: [scope.botId] };
  try {
    if (name === WRITE_PAGE_TOOL) {
      const written = await createPage(deps, {
        spaceId: scope.spaceId,
        userId: scope.userId,
        botId: scope.botId,
        groupId: scope.groupId,
        runId: scope.runId,
        title: text(args.title),
        markdown: clean(text(args.markdown)),
        operationId: scope.operationId,
      });
      return {
        result: {
          ok: true,
          page_id: written.page.id,
          title: written.page.title,
          version: written.page.version,
          shown_to_user: true,
        },
        block: written.block,
      };
    }
    const pageId = text(args.page_id).trim();
    if (!pageId) return { result: { error: "page_id is required" } };
    if (name === READ_PAGE_TOOL) {
      const page = await readPage(deps, { ...owner, pageId });
      return {
        result: {
          page_id: page.id,
          title: page.title,
          version: page.version,
          updated_at: page.updatedAt,
          markdown: page.markdown,
        },
      };
    }
    if (name === EDIT_PAGE_TOOL) {
      let markdown = text(args.markdown);
      let baseVersion: number | undefined;
      if (args.edits !== undefined && args.edits !== null) {
        if (markdown) return { result: { error: "pass edits or markdown, not both" } };
        const edits = pageEdits(args.edits);
        if ("error" in edits) return { result: edits };
        const current = await readPage(deps, { ...owner, pageId });
        const applied = applyPageEdits(current.markdown, edits);
        if (!applied.ok) return { result: { error: applied.error, page_id: pageId } };
        markdown = applied.markdown;
        baseVersion = current.version;
      }
      if (!markdown.trim()) return { result: { error: "pass edits or the new markdown" } };
      const written = await updatePage(deps, {
        ...owner,
        pageId,
        markdown: clean(markdown),
        runId: scope.runId,
        operationId: scope.operationId,
        baseVersion,
      });
      return {
        result: {
          ok: true,
          page_id: written.page.id,
          title: written.page.title,
          version: written.page.version,
          shown_to_user: true,
        },
        block: written.block,
      };
    }
    return { result: { error: `unknown page tool ${name}` } };
  } catch (error) {
    if (error instanceof PageError) return { result: { error: error.message } };
    throw error;
  }
}
