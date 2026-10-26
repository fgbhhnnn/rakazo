import { describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { findModelCredential, findModelCredentialById } from "./model-credentials.js";
import { currentDbContext, runAsSystem, runAsTenant, withinScope } from "./row-security.js";
import { findDefaultVoiceCredential } from "./voice-credentials.js";

const owner = { userId: "owner", spaceId: "owner-space" };
const member = { userId: "member", spaceId: "member-space" };

/** Mimics row-level security: credential rows only join for the tenant user that owns them. */
function rlsPrisma() {
  const credential = { id: "cred", provider: "openai", secretId: "secret", userId: owner.userId };
  const visible = () => {
    const ctx = currentDbContext();
    return ctx?.kind === "system" || (ctx?.kind === "tenant" && ctx.userId === owner.userId);
  };
  const preference = () => ({
    id: "pref",
    modelId: "gpt",
    voiceId: "v",
    speechModel: null,
    thinkingLevel: null,
    isDefault: true,
    updatedAt: new Date(0),
    credential: visible()
      ? { ...credential, updatedAt: new Date(0), createdAt: new Date(0) }
      : null,
  });
  const credentialRow = () =>
    visible() ? { ...credential, updatedAt: new Date(0), createdAt: new Date(0) } : null;
  return {
    userModelPreference: {
      findFirst: async () => preference(),
      findMany: async () => [preference()],
    },
    userModelCredential: {
      findMany: async () => {
        const row = credentialRow();
        return row ? [row] : [];
      },
      findFirst: async () => {
        const row = credentialRow();
        return row ? { ...row, userPreferences: [{ modelId: "gpt", thinkingLevel: null }] } : null;
      },
    },
    spaceSettingOverride: { findUnique: async () => null },
    userVoicePreference: { findFirst: async () => preference() },
    spaceVoicePreference: { findFirst: async () => preference() },
  } as unknown as PrismaClient;
}

describe("withinScope", () => {
  it("switches tenant only when the scope belongs to another user", async () => {
    await runAsTenant(member, async () => {
      expect(await withinScope(owner, () => currentDbContext())).toEqual({
        kind: "tenant",
        ...owner,
      });
      expect(await withinScope(member, () => currentDbContext())).toEqual({
        kind: "tenant",
        ...member,
      });
      expect(currentDbContext()).toEqual({ kind: "tenant", ...member });
    });
    await runAsSystem("test", async () => {
      expect(await withinScope(owner, () => currentDbContext())).toMatchObject({ kind: "system" });
    });
  });

  it("lets a member read the owner's shared model and voice credentials", async () => {
    const prisma = rlsPrisma();
    await runAsTenant(member, async () => {
      expect(await findModelCredentialById(prisma, owner, "cred")).toMatchObject({
        provider: "openai",
      });
      expect(await findModelCredential(prisma, owner, "openai", "gpt")).toMatchObject({
        id: "cred",
      });
      expect(await findDefaultVoiceCredential(prisma, owner)).toMatchObject({ provider: "openai" });
    });
  });

  it("treats a credential hidden by row security as missing instead of throwing", async () => {
    const prisma = rlsPrisma();
    // The member's own tenant cannot see the owner's credential row.
    await runAsTenant(member, async () => {
      expect(await findModelCredentialById(prisma, member, "cred")).toBeNull();
      expect(await findDefaultVoiceCredential(prisma, member)).toBeNull();
    });
  });
});
