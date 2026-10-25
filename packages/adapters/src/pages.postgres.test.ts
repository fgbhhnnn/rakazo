import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPageTool } from "./page-tools.js";
import { createPage, listPages, PageError, readPage, runPageBlocks, updatePage } from "./pages.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

describePostgres("pages (PostgreSQL)", () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const userId = `pages-user-${suffix}`;
  const otherUserId = `pages-other-${suffix}`;
  const organizationId = `pages-org-${suffix}`;
  const spaceId = `pages-space-${suffix}`;
  const otherSpaceId = `pages-space-b-${suffix}`;
  const actor: Actor = {
    userId,
    spaceId,
    email: `${userId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const outsider: Actor = {
    userId: otherUserId,
    spaceId: otherSpaceId,
    email: `${otherUserId}@rakazo.test`,
    isDeploymentOwner: false,
  };
  const blobs = new Map<string, Uint8Array>();
  let puts = 0;
  const artifacts = {
    async put(input: { bytes: Uint8Array }) {
      puts += 1;
      const id = `page-blob-${suffix}-${puts}`;
      blobs.set(id, input.bytes);
      return { id };
    },
    async get(id: string) {
      const bytes = blobs.get(id);
      if (!bytes) throw new Error("missing blob");
      return bytes;
    },
    async remove(id: string) {
      blobs.delete(id);
    },
  } as unknown as ArtifactStore;
  let prisma: PrismaClient;
  let system: PrismaClient;
  let close: () => Promise<void>;
  let botId: string;
  let otherBotId: string;
  let runId: string;
  let deps: { prisma: PrismaClient; artifacts: ArtifactStore };
  const asOwner = <T>(fn: () => Promise<T>) => runAsTenant(actor, fn);

  beforeAll(async () => {
    const db = createDb(databaseUrl!);
    prisma = db.prisma;
    system = asSystem(prisma);
    deps = { prisma, artifacts };
    close = async () => {
      await db.prisma.$disconnect();
      await db.pool.end();
    };
    for (const id of [userId, otherUserId])
      await system.user.create({
        data: { id, name: id, email: `${id}@rakazo.test`, emailVerified: false },
      });
    await system.organization.create({
      data: { id: organizationId, name: "Pages Org", slug: organizationId, createdAt: new Date() },
    });
    await system.space.create({
      data: { id: spaceId, organizationId, name: "General", isDefault: true },
    });
    await system.space.create({ data: { id: otherSpaceId, organizationId, name: "Other" } });
    botId = (await system.bot.create({ data: { spaceId, userId, name: "Chief", color: "blue" } }))
      .id;
    otherBotId = (
      await system.bot.create({ data: { spaceId, userId, name: "Scout", color: "green" } })
    ).id;
    const thread = await system.thread.create({ data: { spaceId, userId, botId } });
    const task = await system.task.create({
      data: { spaceId, botId, threadId: thread.id, userId, prompt: "p", status: "running" },
    });
    runId = (
      await system.run.create({
        data: {
          spaceId,
          userId,
          botId,
          threadId: thread.id,
          taskId: task.id,
          trigger: "user",
          status: "running",
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await system.organization.deleteMany({ where: { id: organizationId } });
    await system.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await close();
  });

  it("writes a page as a versioned markdown artifact family", async () => {
    const written = await asOwner(() =>
      createPage(deps, {
        spaceId,
        userId,
        botId,
        runId,
        title: "Launch plan",
        markdown: "## Goals\nShip pages.\n",
        operationId: "op-1",
      }),
    );
    expect(written.page).toMatchObject({
      title: "Launch plan",
      version: 1,
      snippet: "Ship pages.",
    });
    expect(written.block).toMatchObject({
      kind: "file",
      mimeType: "text/markdown",
      name: "Launch plan",
      page: { pageId: written.page.id, snippet: "Ship pages." },
    });
    const row = await system.artifact.findUniqueOrThrow({ where: { id: written.page.id } });
    expect(row).toMatchObject({ kind: "page", rootArtifactId: null, version: 1, botId, runId });
  });

  it("edits the same page and keeps its id; a stale edit is refused", async () => {
    const created = await asOwner(() =>
      createPage(deps, {
        spaceId,
        userId,
        botId,
        title: "Tracker",
        markdown: "- [ ] one\n",
        operationId: "op-2",
      }),
    );
    const edited = await asOwner(() =>
      updatePage(deps, {
        spaceId,
        userId,
        pageId: created.page.id,
        markdown: "- [x] one\n- [ ] two\n",
        baseVersion: 1,
        operationId: "op-3",
      }),
    );
    expect(edited.page).toMatchObject({ id: created.page.id, version: 2, title: "Tracker" });
    expect(edited.block.page?.pageId).toBe(created.page.id);
    await expect(
      asOwner(() =>
        updatePage(deps, {
          spaceId,
          userId,
          pageId: created.page.id,
          markdown: "late",
          baseVersion: 1,
          operationId: "op-4",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const read = await asOwner(() => readPage(deps, { spaceId, userId, pageId: created.page.id }));
    expect(read).toMatchObject({ version: 2, markdown: "- [x] one\n- [ ] two\n" });
    const listed = await asOwner(() => listPages(prisma, { spaceId, userId, botId }));
    expect(listed[0]).toMatchObject({
      id: created.page.id,
      version: 2,
      artifactId: edited.page.artifactId,
    });
    expect(listed.filter((page) => page.id === created.page.id)).toHaveLength(1);
  });

  it("gives a new subject with a taken title its own page", async () => {
    const again = await asOwner(() =>
      createPage(deps, {
        spaceId,
        userId,
        botId,
        title: "launch PLAN",
        markdown: "Another plan\n",
        operationId: "op-5",
      }),
    );
    expect(again.page).toMatchObject({ title: "launch PLAN (2)", version: 1 });
  });

  it("lets a bot edit only its own pages", async () => {
    const page = await asOwner(() =>
      createPage(deps, {
        spaceId,
        userId,
        botId,
        title: "Memo",
        markdown: "hello\n",
        operationId: "op-6",
      }),
    );
    const scope = { spaceId, userId, runId, operationId: "op-7" };
    const denied = await asOwner(() =>
      runPageTool(deps, { ...scope, botId: otherBotId }, "edit_page", {
        page_id: page.page.id,
        markdown: "hijack",
      }),
    );
    expect(denied.result).toEqual({ error: "page not found" });
    const allowed = await asOwner(() =>
      runPageTool(deps, { ...scope, botId }, "edit_page", {
        page_id: page.page.id,
        edits: [{ find: "hello", replace: "hello again" }],
      }),
    );
    expect(allowed.result).toMatchObject({ ok: true, version: 2 });
    const blocks = await asOwner(() => runPageBlocks(prisma, { id: runId, spaceId }));
    expect(blocks.map((block) => block.page?.pageId)).toContain(page.page.id);
    expect(blocks.find((block) => block.page?.pageId === page.page.id)?.artifactId).toBe(
      (await system.artifact.findFirstOrThrow({ where: { rootArtifactId: page.page.id } })).id,
    );
  });

  it("keeps pages inside their space and owner under row-level security", async () => {
    const page = await asOwner(() =>
      createPage(deps, {
        spaceId,
        userId,
        botId,
        title: "Private",
        markdown: "secret plan\n",
        operationId: "op-8",
      }),
    );
    await expect(
      runAsTenant(outsider, () =>
        readPage(deps, { spaceId: otherSpaceId, userId: otherUserId, pageId: page.page.id }),
      ),
    ).rejects.toBeInstanceOf(PageError);
    // Even a query naming the owner's space sees nothing from another tenant's session.
    const leaked = await runAsTenant(outsider, () =>
      prisma.artifact.findMany({ where: { id: page.page.id } }),
    );
    expect(leaked).toEqual([]);
    expect(
      await runAsTenant(outsider, () =>
        listPages(prisma, { spaceId: otherSpaceId, userId: otherUserId }),
      ),
    ).toEqual([]);
  });
});
