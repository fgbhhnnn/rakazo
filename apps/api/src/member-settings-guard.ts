import { ORPCError } from "@orpc/server";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { memberSettingsLocked } from "@rakazo/db";
import { sealTurnstileSecret } from "./turnstile-settings.js";

/** Members of a locked deployment run on the owner's settings and cannot change them. */
export async function assertMemberSettingsUnlocked(
  prisma: Pick<PrismaClient, "deploymentSettings" | "user">,
  actor: Pick<Actor, "userId" | "isDeploymentOwner">,
): Promise<void> {
  if (actor.isDeploymentOwner) return;
  if (await memberSettingsLocked(prisma, actor.userId)) {
    throw new ORPCError("FORBIDDEN", { message: "Your administrator manages this setting." });
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
