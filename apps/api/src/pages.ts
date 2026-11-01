import { ORPCError } from "@orpc/server";
import type { ArtifactStore } from "@rakazo/adapter-kit";
import { listPages, PageError, readPage, updatePage } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

type PageApiDeps = { prisma: PrismaClient; artifacts: ArtifactStore };

/** Pages open only for the signed-in user who owns them; there is no public link. */
function asRpcError(error: unknown): never {
  if (error instanceof PageError) throw new ORPCError(error.code, { message: error.message });
  throw error;
}

export function listOwnedPages(
  deps: Pick<PageApiDeps, "prisma">,
  actor: Actor,
  input: { botId?: string; limit?: number },
) {
  return listPages(deps.prisma, {
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: input.botId,
    limit: input.limit,
  });
}

export function getOwnedPage(deps: PageApiDeps, actor: Actor, input: { pageId: string }) {
  return readPage(deps, {
    spaceId: actor.spaceId,
    userId: actor.userId,
    pageId: input.pageId,
  }).catch(asRpcError);
}

/** The owner's own edit: saved as the page's next version, which the bot reads next time. */
export async function updateOwnedPage(
  deps: PageApiDeps,
  actor: Actor,
  input: { pageId: string; markdown: string; baseVersion?: number },
) {
  const written = await updatePage(deps, {
    spaceId: actor.spaceId,
    userId: actor.userId,
    pageId: input.pageId,
    markdown: input.markdown,
    baseVersion: input.baseVersion,
    operationId: `page-edit:${input.pageId}:${Date.now()}`,
  }).catch(asRpcError);
  return written.page;
}
