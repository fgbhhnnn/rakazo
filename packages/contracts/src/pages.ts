import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "./ids.js";

/** A Page is a markdown artifact family the bot writes for reports, plans, memos and trackers. */
export const PAGE_ARTIFACT_KIND = "page";
export const PAGE_MIME_TYPE = "text/markdown";
export const PAGE_TITLE_MAX_LENGTH = 120;
export const PAGE_MARKDOWN_MAX_LENGTH = 200_000;
export const PAGE_SNIPPET_MAX_LENGTH = 160;
export const PAGE_EDITS_MAX = 50;

/** Extra data on a thread file block when the file is a Page; older clients show a file card. */
export const PageBlockMetaSchema = z.object({
  pageId: Id,
  snippet: z
    .string()
    .max(PAGE_SNIPPET_MAX_LENGTH * 2)
    .optional(),
});
export type PageBlockMeta = z.infer<typeof PageBlockMetaSchema>;

export const PageSummarySchema = z.object({
  /** The family root artifact id; stable across edits. */
  id: Id,
  /** The latest version's artifact id. */
  artifactId: Id,
  botId: Id.nullable(),
  groupId: Id.nullable(),
  title: z.string(),
  snippet: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PageSummary = z.infer<typeof PageSummarySchema>;

export const PageSchema = PageSummarySchema.extend({ markdown: z.string() });
export type Page = z.infer<typeof PageSchema>;

export const pagesContract = {
  list: oc
    .input(z.object({ botId: Id.optional(), limit: z.number().int().min(1).max(100).optional() }))
    .output(z.array(PageSummarySchema)),
  get: oc.input(z.object({ pageId: Id })).output(PageSchema),
  update: oc
    .input(
      z.object({
        pageId: Id,
        markdown: z.string().min(1).max(PAGE_MARKDOWN_MAX_LENGTH),
        /** The version the edit started from; a newer saved version rejects the edit. */
        baseVersion: z.number().int().positive().optional(),
      }),
    )
    .output(PageSchema),
};

export type PageSection = {
  /** Anchor id, unique within the page. */
  id: string;
  level: number;
  /** Heading text without markdown marks. */
  title: string;
  /** The heading line and the body up to the next heading. */
  markdown: string;
};

export type PageOutline = {
  /** Markdown before the first heading. */
  intro: string;
  sections: PageSection[];
};

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

/** Heading text as plain words: links, emphasis and code marks removed. */
export function plainHeadingText(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugBase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 64);
}

/** Splits page markdown at its headings (outside code fences) for the reader and its contents list. */
export function pageOutline(markdown: string): PageOutline {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const intro: string[] = [];
  const sections: PageSection[] = [];
  const used = new Map<string, number>();
  let fence: string | null = null;
  let current: { id: string; level: number; title: string; lines: string[] } | null = null;
  const flush = () => {
    if (current)
      sections.push({
        id: current.id,
        level: current.level,
        title: current.title,
        markdown: current.lines.join("\n").trimEnd(),
      });
  };
  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const mark = fenceMatch[1] ?? "";
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
    }
    const heading = fence || fenceMatch ? null : HEADING.exec(line);
    if (heading) {
      flush();
      const title = plainHeadingText(heading[2] ?? "");
      const base = slugBase(title) || `section-${sections.length + 1}`;
      const seen = used.get(base) ?? 0;
      used.set(base, seen + 1);
      current = {
        id: seen === 0 ? base : `${base}-${seen + 1}`,
        level: heading[1]?.length ?? 1,
        title,
        lines: [line],
      };
      continue;
    }
    if (current) current.lines.push(line);
    else intro.push(line);
  }
  flush();
  return { intro: intro.join("\n").trim(), sections };
}

/** Drops a leading heading that only repeats the page title, so the reader shows the title once. */
export function withoutRepeatedTitle(outline: PageOutline, title: string): PageOutline {
  const first = outline.sections[0];
  if (outline.intro || !first) return outline;
  if (first.title.trim().toLowerCase() !== plainHeadingText(title).toLowerCase()) return outline;
  const body = first.markdown.split("\n").slice(1).join("\n").trim();
  return { intro: body, sections: outline.sections.slice(1) };
}

/** The headings a contents list shows: up to three levels deep. */
export function pageContents(outline: PageOutline): PageSection[] {
  return outline.sections.filter((section) => section.level <= 3 && section.title);
}

export type PageLayout = {
  intro: string;
  sections: PageSection[];
  /** The "On this page" entries, with depth counted from the page's top heading level. */
  contents: Array<PageSection & { depth: number }>;
};

/** What a reader draws: the anchored sections without a repeated title, plus the contents list. */
export function pageLayout(markdown: string, title: string): PageLayout {
  const outline = withoutRepeatedTitle(pageOutline(markdown), title);
  const headings = pageContents(outline);
  const top = Math.min(...headings.map((section) => section.level));
  return {
    intro: outline.intro,
    sections: outline.sections,
    contents: headings.map((section) => ({ ...section, depth: section.level - top })),
  };
}

/** A short plain-text preview of the page body for chat cards and lists. */
export function pageSnippet(markdown: string, maxChars = PAGE_SNIPPET_MAX_LENGTH): string {
  const kept: string[] = [];
  let fence = false;
  for (const line of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (FENCE.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence || HEADING.test(line) || /^\s*\|/.test(line) || /^\s*([-*_])\1{2,}\s*$/.test(line))
      continue;
    kept.push(line);
  }
  const text = kept
    .join(" ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(^|\s)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars
    .slice(0, maxChars - 1)
    .join("")
    .trimEnd()}…`;
}

export type PageEdit = { find: string; replace: string };

/** Applies find/replace edits in order; each find must match exactly once. */
export function applyPageEdits(
  markdown: string,
  edits: readonly PageEdit[],
): { ok: true; markdown: string } | { ok: false; error: string } {
  let next = markdown;
  for (const [index, edit] of edits.entries()) {
    if (!edit.find) return { ok: false, error: `edit ${index + 1}: find is empty` };
    const first = next.indexOf(edit.find);
    if (first < 0) return { ok: false, error: `edit ${index + 1}: find text not found` };
    if (next.indexOf(edit.find, first + 1) >= 0)
      return {
        ok: false,
        error: `edit ${index + 1}: find text matches more than once; include more context`,
      };
    next = next.slice(0, first) + edit.replace + next.slice(first + edit.find.length);
  }
  return { ok: true, markdown: next };
}

/** The signed-in link to a page; it opens only for the page's owner. */
export function pagePath(pageId: string): string {
  return `/app/pages/${encodeURIComponent(pageId)}`;
}
