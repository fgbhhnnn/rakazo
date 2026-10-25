import type { PrismaClient } from "./client.js";
import { ownsMemberSettingsUser, sharedOwnerUserId } from "./deployment-admin.js";
import { runAsSystem } from "./row-security.js";

type Scope = { userId: string; spaceId: string };

type MemberSettingsRow = {
  ownerUserId: string | null;
  lockMemberSettings: boolean | null;
  shareOwnerModels: boolean | null;
} | null;

export type MemberSettingsPolicy = {
  ownerUserId: string | null;
  /** Only the deployment owner may change models, voice and integrations. */
  locked: boolean;
  /** Members without their own model or voice run on the owner's defaults. */
  shareOwner: boolean;
};

export function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/** Stored values win; a null column falls back to the environment default. */
export function memberSettingsPolicy(
  row: MemberSettingsRow,
  env: Record<string, string | undefined> = process.env,
): MemberSettingsPolicy {
  const locked = row?.lockMemberSettings ?? envFlag(env.RAKAZO_LOCK_MEMBER_SETTINGS) ?? false;
  const shareOwner = row?.shareOwnerModels ?? envFlag(env.RAKAZO_SHARE_OWNER_MODELS) ?? locked;
  return { ownerUserId: row?.ownerUserId ?? null, locked, shareOwner };
}

export async function loadMemberSettingsPolicy(
  prisma: Pick<PrismaClient, "deploymentSettings">,
): Promise<MemberSettingsPolicy> {
  // Partial clients (narrow test doubles, early boot) have no settings to apply.
  if (typeof prisma.deploymentSettings?.findUnique !== "function")
    return memberSettingsPolicy(null);
  const row = await prisma.deploymentSettings.findUnique({
    where: { id: "default" },
    select: { ownerUserId: true, lockMemberSettings: true, shareOwnerModels: true },
  });
  return memberSettingsPolicy(row);
}

/** True when this user is a member whose model, voice and integration settings are owner-managed. */
export async function memberSettingsLocked(
  prisma: Pick<PrismaClient, "deploymentSettings"> & Partial<Pick<PrismaClient, "user">>,
  userId: string,
): Promise<boolean> {
  const policy = await loadMemberSettingsPolicy(prisma);
  return policy.locked && !(await ownsMemberSettingsUser(prisma, { userId }, policy.ownerUserId));
}

/** The owner whose defaults this member borrows, or null when the member uses their own. */
async function borrowedOwner(prisma: PrismaClient, policy: MemberSettingsPolicy, userId: string) {
  if (!policy.shareOwner) return null;
  const ownerUserId = await sharedOwnerUserId(prisma, policy.ownerUserId);
  if (!ownerUserId || ownerUserId === userId) return null;
  if (await ownsMemberSettingsUser(prisma, { userId }, policy.ownerUserId)) return null;
  return ownerUserId;
}

/**
 * The scope model lookups run under. A member with no model of their own borrows the
 * owner's default space, so credential, secret and backup lookups all resolve as the owner
 * would. Server-side only: the owner's secrets never leave the process.
 */
export async function sharedModelScope<S extends Scope>(
  prisma: PrismaClient,
  scope: S,
): Promise<S | Scope> {
  const policy = await loadMemberSettingsPolicy(prisma);
  const ownerUserId = await borrowedOwner(prisma, policy, scope.userId);
  if (!ownerUserId) return scope;
  const own = await prisma.userModelCredential.count({ where: { userId: scope.userId } });
  if (own > 0 && !policy.locked) return scope;
  // The owner's main model lives in their main role; the legacy default preference is
  // frozen since role writes stopped mirroring into it, so it only breaks ties between
  // Spaces that each have a main model, and covers owners who never wrote a role.
  const legacy = await prisma.spaceModelPreference.findFirst({
    where: { userId: ownerUserId, isDefault: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { spaceId: true },
  });
  const roles =
    typeof prisma.spaceModelRoleChoice?.findMany === "function"
      ? // Role rows are tenant-scoped and the caller is the member, so list only the
        // owner's Space ids across their Spaces; the choices themselves are read as the owner.
        await runAsSystem("shared owner model space", () =>
          prisma.spaceModelRoleChoice.findMany({
            where: { userId: ownerUserId, role: "main", position: 0 },
            orderBy: { spaceId: "asc" },
            select: { spaceId: true },
          }),
        )
      : [];
  const spaceId =
    roles.find((role) => role.spaceId === legacy?.spaceId)?.spaceId ??
    roles[0]?.spaceId ??
    legacy?.spaceId;
  return spaceId ? { userId: ownerUserId, spaceId } : scope;
}

/** Same as sharedModelScope, for the voice provider. */
export async function sharedVoiceScope<S extends Scope>(
  prisma: PrismaClient,
  scope: S,
): Promise<S | Scope> {
  const policy = await loadMemberSettingsPolicy(prisma);
  const ownerUserId = await borrowedOwner(prisma, policy, scope.userId);
  if (!ownerUserId) return scope;
  const own = await prisma.userVoiceCredential.count({ where: { userId: scope.userId } });
  if (own > 0 && !policy.locked) return scope;
  const owner = await prisma.spaceVoicePreference.findFirst({
    where: { userId: ownerUserId, isDefault: true },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { spaceId: true },
  });
  return owner ? { userId: ownerUserId, spaceId: owner.spaceId } : scope;
}
