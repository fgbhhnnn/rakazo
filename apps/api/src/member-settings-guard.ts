import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { ApprovalRulesLockedError, memberSettingsLocked } from "@rakazo/db";
import { sealTurnstileSecret } from "./turnstile-settings.js";

export const MEMBER_SETTINGS_LOCKED_MESSAGE = "Your administrator manages this setting.";

/** Whether this actor may change settings a locked deployment reserves for owners and admins. */
export async function mayChangeMemberSettings(
  prisma: Pick<PrismaClient, "deploymentSettings" | "user">,
  actor: Pick<Actor, "userId" | "isDeploymentOwner">,
): Promise<boolean> {
  if (actor.isDeploymentOwner) return true;
  return !(await memberSettingsLocked(prisma, actor.userId));
}

/**
 * An "always" answer on an approval card saves an allow rule. A locked deployment's member may
 * still answer once; only the rule is reserved, so ask for its write permission up front.
 */
export async function approvalAnswerPermission(
  prisma: Pick<PrismaClient, "deploymentSettings" | "user">,
  actor: Pick<Actor, "userId" | "isDeploymentOwner">,
  answer: string,
): Promise<boolean | undefined> {
  return answer === "always" ? mayChangeMemberSettings(prisma, actor) : undefined;
}

/** The refused "always" answer reads as the same lock message as the settings screens. */
export function approvalRulesLockedError(error: unknown): unknown {
  return error instanceof ApprovalRulesLockedError
    ? new ORPCError("FORBIDDEN", { message: MEMBER_SETTINGS_LOCKED_MESSAGE })
    : error;
}

/** Members of a locked deployment run on the owner's settings and cannot change them. */
export async function assertMemberSettingsUnlocked(
  prisma: Pick<PrismaClient, "deploymentSettings" | "user">,
  actor: Pick<Actor, "userId" | "isDeploymentOwner">,
): Promise<void> {
  if (!(await mayChangeMemberSettings(prisma, actor))) {
    throw new ORPCError("FORBIDDEN", { message: MEMBER_SETTINGS_LOCKED_MESSAGE });
  }
}

/** Deployment-settings columns for the owner's member lock and signup check changes. */
export async function memberAndSignupCheckUpdate(
  secrets: Pick<SecretStore, "put">,
  owner: { userId: string; spaceId: string },
  input: {
    lockMemberSettings?: boolean;
    shareOwnerModels?: boolean;
    turnstileEnabled?: boolean;
    turnstileSiteKey?: string;
    turnstileSecretKey?: string;
  },
) {
  return {
    ...(input.lockMemberSettings === undefined
      ? {}
      : { lockMemberSettings: input.lockMemberSettings }),
    ...(input.shareOwnerModels === undefined ? {} : { shareOwnerModels: input.shareOwnerModels }),
    ...(input.turnstileEnabled === undefined ? {} : { turnstileEnabled: input.turnstileEnabled }),
    ...(input.turnstileSiteKey === undefined
      ? {}
      : { turnstileSiteKey: input.turnstileSiteKey || null }),
    ...(input.turnstileSecretKey === undefined
      ? {}
      : {
          turnstileSecretCipher: await sealTurnstileSecret(
            secrets,
            input.turnstileSecretKey,
            owner,
          ),
        }),
  };
}
