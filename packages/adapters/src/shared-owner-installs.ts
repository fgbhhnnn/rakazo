import type { AdapterContext } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  envFlag,
  loadMemberSettingsPolicy,
  ownsMemberSettingsUser,
  sharedOwnerUserId,
  withinScope,
} from "@rakazo/db";

/**
 * Owner-shared MCP tool sources (RAKAZO_SHARE_OWNER_TOOLS).
 *
 * On a locked deployment members cannot add or manage MCP sources, so with this flag on
 * a member's runs also discover the deployment owner's installed MCP sources
 * (`capability_installs` rows of kind "mcp") and call them with the owner's credential.
 * Only the server ever reads that credential: it is loaded as the owner (row-level
 * security on `secrets` still applies) and redacted, with the source URL and header
 * values, from everything a call returns. Members never list the owner's rows.
 *
 * With the flag off nothing here touches the database, so behaviour is unchanged.
 */

type Env = Record<string, string | undefined>;
type Db = Pick<PrismaClient, "deploymentSettings" | "user" | "capabilityInstall" | "secret">;
type SharedRow = { id: string; userId: string; spaceId: string; source: string; config: unknown };

/** Rows this module handed out, with the owner scope their secret is read in. */
const sharedRows = new WeakMap<object, { userId: string; spaceId: string; redact: string[] }>();

export function shareOwnerToolsEnabled(env: Env = process.env): boolean {
  return envFlag(env.RAKAZO_SHARE_OWNER_TOOLS) === true;
}

/**
 * The owner whose MCP sources this user borrows, or null. Requires the flag, an active member
 * lock, a resolvable owner, and a user who does not manage member settings themselves.
 */
export async function sharedToolsOwner(
  prisma: Pick<Db, "deploymentSettings" | "user">,
  userId: string,
  env: Env = process.env,
): Promise<string | null> {
  if (!shareOwnerToolsEnabled(env)) return null;
  if (typeof prisma.deploymentSettings?.findUnique !== "function") return null;
  const policy = await loadMemberSettingsPolicy(prisma);
  if (!policy.locked) return null;
  const ownerUserId = await sharedOwnerUserId(prisma, policy.ownerUserId, env);
  if (!ownerUserId || ownerUserId === userId) return null;
  if (await ownsMemberSettingsUser(prisma, { userId }, policy.ownerUserId, env)) return null;
  return ownerUserId;
}

function markShared<T extends SharedRow>(row: T): T {
  sharedRows.set(row, {
    userId: row.userId,
    spaceId: row.spaceId,
    redact: [row.source, ...publicHeaderValues(row.config)],
  });
  return row;
}

function publicHeaderValues(config: unknown): string[] {
  const headers =
    config && typeof config === "object" ? (config as { headers?: unknown }).headers : undefined;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return [];
  return Object.values(headers).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

/** The owner's MCP sources this run may use; empty unless sharing applies. */
export async function sharedOwnerMcpInstalls<T extends SharedRow>(
  prisma: Db,
  context: Pick<AdapterContext, "userId">,
  env: Env = process.env,
): Promise<T[]> {
  const ownerUserId = await sharedToolsOwner(prisma, context.userId, env);
  if (!ownerUserId) return [];
  const rows = (await prisma.capabilityInstall.findMany({
    where: { userId: ownerUserId, kind: "mcp" },
    orderBy: { createdAt: "asc" },
  })) as unknown as T[];
  return rows.map(markShared);
}

/** One of the owner's shared MCP sources by id, or null when it is not one this run may use. */
export async function sharedOwnerMcpInstall<T extends SharedRow>(
  prisma: Db,
  context: Pick<AdapterContext, "userId">,
  id: string,
  env: Env = process.env,
): Promise<T | null> {
  const ownerUserId = await sharedToolsOwner(prisma, context.userId, env);
  if (!ownerUserId) return null;
  const row = (await prisma.capabilityInstall.findFirst({
    where: { id, userId: ownerUserId, kind: "mcp" },
  })) as unknown as T | null;
  return row ? markShared(row) : null;
}

export function isSharedOwnerInstall(install: object): boolean {
  return sharedRows.has(install);
}

/** Values a shared source's results and errors must not show the member. */
export function sharedOwnerRedactions(install: object): string[] {
  return sharedRows.get(install)?.redact ?? [];
}

/** A shared source's credential, read as its owner so row-level security still applies. */
export async function loadSharedOwnerCredential(
  prisma: Pick<Db, "secret">,
  install: { secretId: string | null },
  load: (row: { ciphertext: string; id: string }) => Promise<string>,
): Promise<string | undefined> {
  const owner = sharedRows.get(install);
  if (!owner || !install.secretId) return undefined;
  const secretId = install.secretId;
  return withinScope({ userId: owner.userId, spaceId: owner.spaceId }, async () => {
    const row = await prisma.secret.findFirst({
      where: { id: secretId, spaceId: owner.spaceId, userId: owner.userId },
    });
    return row ? await load(row) : undefined;
  });
}
