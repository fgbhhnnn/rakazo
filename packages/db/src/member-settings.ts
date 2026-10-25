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
 * The owner's Space a borrowed lookup runs in. Models and voice are account-wide with per-Space
 * overrides, so a Space without an override resolves to the owner's account copy. That copy wins
 * when it holds a setting; otherwise a Space whose own override holds one; otherwise the owner's
 * first Space, so the account copy (and the deployment defaults behind it) still apply.
 */
async function ownerSettingsSpace(
  prisma: PrismaClient,
  ownerUserId: string,
  setting: "models" | "voice",
): Promise<string | null> {
  if (typeof prisma.spaceMember?.findMany !== "function") return null;
  // These rows are tenant-scoped and the caller is the member, so list only the owner's
  // Space ids here; the settings themselves are read as the owner.
  return runAsSystem("shared owner settings space", async () => {
    const memberships = await prisma.spaceMember.findMany({
      where: { userId: ownerUserId },
      orderBy: [{ createdAt: "asc" }, { spaceId: "asc" }],
      select: { spaceId: true },
    });
    if (memberships.length === 0) return null;
    const overrides = await prisma.spaceSettingOverride.findMany({
      where: { userId: ownerUserId, setting },
      select: { spaceId: true },
    });
    const overridden = new Set(overrides.map((row) => row.spaceId));
    const followsAccount = memberships.find((row) => !overridden.has(row.spaceId))?.spaceId;
    const accountHasSetting =
      setting === "models"
        ? (await prisma.userModelRoleChoice.count({
            where: { userId: ownerUserId, role: "main", position: 0 },
          })) > 0
        : (await prisma.userVoicePreference.count({ where: { userId: ownerUserId } })) > 0;
    if (followsAccount && accountHasSetting) return followsAccount;
    const spaceIds = memberships.map((row) => row.spaceId).filter((id) => overridden.has(id));
    const withOwn =
      spaceIds.length === 0
        ? []
        : setting === "models"
          ? await prisma.spaceModelRoleChoice.findMany({
              where: { userId: ownerUserId, spaceId: { in: spaceIds }, role: "main", position: 0 },
              select: { spaceId: true },
            })
          : await prisma.spaceVoicePreference.findMany({
              where: { userId: ownerUserId, spaceId: { in: spaceIds } },
              select: { spaceId: true },
            });
    const own = new Set(withOwn.map((row) => row.spaceId));
    return spaceIds.find((id) => own.has(id)) ?? followsAccount ?? memberships[0]?.spaceId ?? null;
  });
}

/**
 * The scope model lookups run under. A member with no model of their own borrows the
 * owner's models, so credential, secret and backup lookups all resolve as the owner
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
  const spaceId = await ownerSettingsSpace(prisma, ownerUserId, "models");
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
  const spaceId = await ownerSettingsSpace(prisma, ownerUserId, "voice");
  return spaceId ? { userId: ownerUserId, spaceId } : scope;
}
