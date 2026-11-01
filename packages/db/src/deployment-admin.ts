import type { PrismaClient } from "./client.js";

type Env = Record<string, string | undefined>;
type UserLookup = Partial<Pick<PrismaClient, "user">>;
type User = { userId: string; email?: string | null };

/**
 * Deployment admins named on the server: RAKAZO_ADMIN_EMAILS, comma-separated and
 * case-insensitive. Null when unset.
 */
export function deploymentAdminEmails(env: Env = process.env): Set<string> | null {
  const emails = (env.RAKAZO_ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return emails.length > 0 ? new Set(emails) : null;
}

/**
 * Server authority (owner-only deployment settings, isDeploymentOwner on me). Only the env list
 * grants it; when unset no app account has it, as upstream intends.
 */
export function isDeploymentAdmin(user: Pick<User, "email">, env: Env = process.env): boolean {
  const admins = deploymentAdminEmails(env);
  return Boolean(admins && user.email && admins.has(user.email.trim().toLowerCase()));
}

/**
 * Who manages their own models/voice under the member lock: the env admins when the list is
 * set, otherwise the stored deployment_settings.ownerUserId.
 */
export function ownsMemberSettings(
  user: User,
  ownerUserId: string | null,
  env: Env = process.env,
): boolean {
  if (!deploymentAdminEmails(env)) return ownerUserId !== null && ownerUserId === user.userId;
  return isDeploymentAdmin(user, env);
}

/** Same as ownsMemberSettings, looking up the email only when the env list needs it. */
export async function ownsMemberSettingsUser(
  prisma: UserLookup,
  user: User,
  ownerUserId: string | null,
  env: Env = process.env,
): Promise<boolean> {
  if (!deploymentAdminEmails(env) || user.email) return ownsMemberSettings(user, ownerUserId, env);
  if (typeof prisma.user?.findUnique !== "function") return false;
  const row = await prisma.user.findUnique({ where: { id: user.userId }, select: { email: true } });
  return ownsMemberSettings({ userId: user.userId, email: row?.email }, ownerUserId, env);
}

/** Whose models and voice members borrow: the stored owner, else the first listed admin with an account. */
export async function sharedOwnerUserId(
  prisma: UserLookup,
  ownerUserId: string | null,
  env: Env = process.env,
): Promise<string | null> {
  if (ownerUserId) return ownerUserId;
  const admins = deploymentAdminEmails(env);
  if (!admins || typeof prisma.user?.findMany !== "function") return null;
  const users = await prisma.user.findMany({
    where: { email: { in: [...admins], mode: "insensitive" } },
    select: { id: true, email: true },
  });
  for (const email of admins) {
    const match = users.find((user) => user.email.toLowerCase() === email);
    if (match) return match.id;
  }
  return null;
}
