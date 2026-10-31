import { createHash } from "node:crypto";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { MessageBlock, Page, PageSummary } from "@rakazo/contracts";
import {
  PAGE_ARTIFACT_KIND,
  PAGE_MARKDOWN_MAX_LENGTH,
  PAGE_MIME_TYPE,
  PAGE_TITLE_MAX_LENGTH,
  pageSnippet,
  plainHeadingText,
} from "@rakazo/contracts";
import type { Artifact, PrismaClient } from "@rakazo/db";
import { withResolvedArtifactVersion } from "@rakazo/db";

/*
 * Pages are markdown artifact families (kind "page"). The family root id is the page id; an edit
 * writes the next version under the same title, so every client that knows artifacts already
 * stores, versions, lists and secures them. Row-level security comes from the artifacts table.
 */

export type PageDeps = { prisma: PrismaClient; artifacts: ArtifactStore };
export type PageFileBlock = Extract<MessageBlock, { kind: "file" }>;

export class PageError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST",
    message: string,
  ) {
    super(message);
    this.name = "PageError";
  }
}

export type PageWrite = { page: Page; block: PageFileBlock; created: boolean };

type PageRow = Pick<
  Artifact,
  | "id"
  | "name"
  | "description"
  | "mimeType"
  | "size"
  | "version"
  | "createdAt"
  | "botId"
  | "groupId"
  | "rootArtifactId"
>;

/** A title the store accepts: plain words, one line, within the length limit. */
export function normalizePageTitle(title: string): string {
  const plain = plainHeadingText(title.replace(/[\r\n]+/g, " "));
  return Array.from(plain).slice(0, PAGE_TITLE_MAX_LENGTH).join("").trim();
}

export function validatePageMarkdown(markdown: string): string {
  const text = markdown.replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new PageError("BAD_REQUEST", "page markdown is empty");
  if (text.length > PAGE_MARKDOWN_MAX_LENGTH)
    throw new PageError(
      "BAD_REQUEST",
      `page markdown is over ${PAGE_MARKDOWN_MAX_LENGTH} characters; split it into several pages`,
    );
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** The chat block for a page version: a markdown file card that newer clients open as a Page. */
export function pageBlock(row: PageRow, pageId: string): PageFileBlock {
  return {
    kind: "file",
    artifactId: row.id,
    mimeType: row.mimeType,
    name: row.name,
    size: row.size,
    page: { pageId, ...(row.description ? { snippet: row.description } : {}) },
  };
}

function summary(root: PageRow, latest: PageRow): PageSummary {
  return {
    id: root.id,
    artifactId: latest.id,
    botId: root.botId,
    groupId: root.groupId,
    title: root.name,
    snippet: latest.description ?? "",
    version: latest.version,
    createdAt: root.createdAt.toISOString(),
    updatedAt: latest.createdAt.toISOString(),
  };
}

function storeContext(input: {
  operationId: string;
  spaceId: string;
  userId: string;
  botId: string;
}) {
  return {
    operationId: input.operationId,
    traceId: input.operationId,
    spaceId: input.spaceId,
    userId: input.userId,
    botId: input.botId,
    signal: new AbortController().signal,
  };
}

class TitleTaken extends Error {}

async function storeVersion(
  deps: PageDeps,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId: string | null;
    runId: string | null;
    name: string;
    markdown: string;
    operationId: string;
  },
  accept: (version: { rootArtifactId: string | null; version: number }) => void,
): Promise<Artifact> {
  const bytes = new TextEncoder().encode(input.markdown);
  const context = storeContext(input);
  const stored = await deps.artifacts.put(
    { name: `${input.name}.md`, mimeType: PAGE_MIME_TYPE, bytes },
    context,
  );
  try {
    return await withResolvedArtifactVersion(
      deps.prisma,
      {
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        groupId: input.groupId,
        name: input.name,
      },
      async (tx, version) => {
        accept(version);
        return tx.artifact.create({
          data: {
            spaceId: input.spaceId,
            userId: input.userId,
            botId: input.botId,
            groupId: input.groupId,
            runId: input.runId,
            name: input.name,
            description: pageSnippet(input.markdown) || null,
            mimeType: PAGE_MIME_TYPE,
            size: bytes.byteLength,
            hash: createHash("sha256").update(bytes).digest("hex"),
            storageKey: stored.id,
            rootArtifactId: version.rootArtifactId,
            version: version.version,
            kind: PAGE_ARTIFACT_KIND,
          },
        });
      },
    );
  } catch (error) {
    await deps.artifacts.remove(stored.id, context).catch(() => undefined);
    throw error;
  }
}

/** Writes a new page. A title another file of this bot already uses gets a " (2)" suffix. */
export async function createPage(
  deps: PageDeps,
  input: {
    spaceId: string;
    userId: string;
    botId: string;
    groupId?: string | null;
    runId?: string | null;
    title: string;
    markdown: string;
    operationId: string;
  },
): Promise<PageWrite> {
  const title = normalizePageTitle(input.title);
  if (!title) throw new PageError("BAD_REQUEST", "page title is empty");
  const markdown = validatePageMarkdown(input.markdown);
  for (let n = 1; n <= 20; n += 1) {
    const suffix = n === 1 ? "" : ` (${n})`;
    const name = `${Array.from(title)
      .slice(0, PAGE_TITLE_MAX_LENGTH - suffix.length)
      .join("")
      .trim()}${suffix}`;
    try {
      const row = await storeVersion(
        deps,
        {
          spaceId: input.spaceId,
          userId: input.userId,
          botId: input.botId,
          groupId: input.groupId ?? null,
          runId: input.runId ?? null,
          name,
          markdown,
          operationId: input.operationId,
        },
        (version) => {
          if (version.version !== 1) throw new TitleTaken();
        },
      );
      return {
        page: { ...summary(row, row), markdown },
        block: pageBlock(row, row.id),
        created: true,
      };
    } catch (error) {
      if (!(error instanceof TitleTaken)) throw error;
    }
  }
  throw new PageError("CONFLICT", "too many pages share this title; choose another title");
}

async function pageFamily(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; pageId: string; botIds?: readonly string[] },
): Promise<{ root: Artifact; latest: Artifact }> {
  const root = await prisma.artifact.findFirst({
    where: {
      id: input.pageId,
      spaceId: input.spaceId,
      userId: input.userId,
      kind: PAGE_ARTIFACT_KIND,
      rootArtifactId: null,
      ...(input.botIds ? { botId: { in: [...input.botIds] } } : {}),
    },
  });
  if (!root) throw new PageError("NOT_FOUND", "page not found");
  const latest = await prisma.artifact.findFirst({
    where: {
      spaceId: input.spaceId,
      OR: [{ id: root.id }, { rootArtifactId: root.id }],
    },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
  });
  return { root, latest: latest ?? root };
}

/** The latest version of a page the user owns; `botIds` narrows it to pages those bots wrote. */
export async function readPage(
  deps: PageDeps,
  input: { spaceId: string; userId: string; pageId: string; botIds?: readonly string[] },
): Promise<Page> {
  const { root, latest } = await pageFamily(deps.prisma, input);
  const bytes = await deps.artifacts.get(
    latest.storageKey,
    storeContext({
      operationId: `page-read:${latest.id}`,
      spaceId: input.spaceId,
      userId: input.userId,
      botId: root.botId ?? root.groupId ?? root.id,
    }),
  );
  return { ...summary(root, latest), markdown: new TextDecoder().decode(bytes) };
}

/** Saves new markdown as the page's next version. `baseVersion` rejects a stale edit. */
export async function updatePage(
  deps: PageDeps,
  input: {
    spaceId: string;
    userId: string;
    pageId: string;
    markdown: string;
    operationId: string;
    runId?: string | null;
    botIds?: readonly string[];
    baseVersion?: number;
  },
): Promise<PageWrite> {
  const markdown = validatePageMarkdown(input.markdown);
  const { root, latest } = await pageFamily(deps.prisma, input);
  if (!root.botId) throw new PageError("NOT_FOUND", "the bot that wrote this page was removed");
  if (input.baseVersion !== undefined && input.baseVersion !== latest.version)
    throw new PageError("CONFLICT", "page changed since it was opened; reload it and try again");
  const row = await storeVersion(
    deps,
    {
      spaceId: input.spaceId,
      userId: input.userId,
      botId: root.botId,
      groupId: root.groupId,
      runId: input.runId ?? null,
      name: root.name,
      markdown,
      operationId: input.operationId,
    },
    (version) => {
      if ((version.rootArtifactId ?? "") !== root.id)
        throw new PageError("CONFLICT", "another file now uses this page's title");
      if (input.baseVersion !== undefined && version.version !== input.baseVersion + 1)
        throw new PageError(
          "CONFLICT",
          "page changed since it was opened; reload it and try again",
        );
    },
  );
  return {
    page: { ...summary(root, row), markdown },
    block: pageBlock(row, root.id),
    created: false,
  };
}

/** The user's pages, most recently changed first; `botId` keeps one bot's. */
export async function listPages(
  prisma: PrismaClient,
  input: { spaceId: string; userId: string; botId?: string; limit?: number },
): Promise<PageSummary[]> {
  const limit = input.limit ?? 50;
  const where = {
    spaceId: input.spaceId,
    userId: input.userId,
    kind: PAGE_ARTIFACT_KIND,
    ...(input.botId ? { botId: input.botId } : {}),
  };
  const roots = await prisma.artifact.findMany({
    where: { ...where, rootArtifactId: null },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  if (!roots.length) return [];
  const versions = await prisma.artifact.findMany({
    where: { spaceId: input.spaceId, rootArtifactId: { in: roots.map((root) => root.id) } },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
  });
  const latest = new Map<string, Artifact>();
  for (const row of versions) {
    if (row.rootArtifactId && !latest.has(row.rootArtifactId)) latest.set(row.rootArtifactId, row);
  }
  return roots
    .map((root) => summary(root, latest.get(root.id) ?? root))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

/** Cards for the pages a run wrote or edited: the latest version of each, last touched last. */
export async function runPageBlocks(
  prisma: PrismaClient,
  run: { id: string; spaceId: string },
): Promise<PageFileBlock[]> {
  const rows = await prisma.artifact.findMany({
    where: { spaceId: run.spaceId, runId: run.id, kind: PAGE_ARTIFACT_KIND },
    orderBy: [{ createdAt: "asc" }, { version: "asc" }],
  });
  const byPage = new Map<string, Artifact>();
  for (const row of rows) {
    const pageId = row.rootArtifactId ?? row.id;
    byPage.delete(pageId);
    byPage.set(pageId, row);
  }
  return [...byPage.entries()].map(([pageId, row]) => pageBlock(row, pageId));
}
