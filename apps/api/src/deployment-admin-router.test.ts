import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertMemberSettingsUnlocked } from "./member-settings-guard.js";
import { createRouter, type RouterDeps } from "./router.js";

const ADMIN = { userId: "admin-1", email: "Admin@Example.com" };
const SECOND = { userId: "admin-2", email: "second@example.com" };
const MEMBER = { userId: "member-1", email: "member@example.com" };
const STORED_OWNER = { userId: "owner-1", email: "owner@example.com" };

function client(user: { userId: string; email: string }) {
  const row = {
    id: "default",
    ownerUserId: STORED_OWNER.userId,
    lockMemberSettings: true,
    shareOwnerModels: null,
    signupsEnabled: true,
    signupAllowlist: "",
  };
  const upsert = vi.fn().mockResolvedValue(row);
  const prisma = {
    user: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ email: user.email, name: "Test User", signupSurvey: null }),
      findUnique: vi.fn().mockResolvedValue({ email: user.email }),
    },
    userModelCredential: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn() },
    spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
    deploymentSettings: { findUnique: vi.fn().mockResolvedValue(row), upsert },
  } as unknown as PrismaClient;
  const deps = {
    prisma,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake-model",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-router-test",
  } as unknown as RouterDeps;
  const actor = { spaceId: "space-1", ...user, isDeploymentOwner: false } satisfies Actor;
  return { rpc: createRouterClient(createRouter(deps), { context: { actor } }), upsert };
}

describe("RAKAZO_ADMIN_EMAILS deployment admins", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("marks every listed email as owner, case-insensitively, and unlocks their settings", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "admin@example.com, SECOND@example.com");
    for (const user of [ADMIN, SECOND]) {
      await expect(client(user).rpc.me()).resolves.toMatchObject({
        isDeploymentOwner: true,
        memberSettingsLocked: false,
      });
    }
  });

  it("lets admins read and change deployment settings", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "admin@example.com");
    const admin = client(ADMIN);
    await expect(admin.rpc.deployment.get()).resolves.toMatchObject({
      ownerUserId: STORED_OWNER.userId,
      lockMemberSettings: true,
    });
    await expect(admin.rpc.deployment.update({ lockMemberSettings: false })).resolves.toBeTruthy();
    expect(admin.upsert).toHaveBeenCalledTimes(1);
  });

  it("denies non-admins, including the stored owner when not listed", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "admin@example.com");
    for (const user of [MEMBER, STORED_OWNER]) {
      const c = client(user);
      await expect(c.rpc.me()).resolves.toMatchObject({
        isDeploymentOwner: false,
        memberSettingsLocked: true,
      });
      await expect(c.rpc.deployment.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.rpc.deployment.update({ signupsEnabled: false })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      expect(c.upsert).not.toHaveBeenCalled();
    }
  });

  it("keeps today's behavior when unset: no server authority, stored owner not locked", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    const owner = client(STORED_OWNER);
    await expect(owner.rpc.me()).resolves.toMatchObject({
      isDeploymentOwner: false,
      memberSettingsLocked: false,
    });
    await expect(owner.rpc.deployment.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(client(MEMBER).rpc.me()).resolves.toMatchObject({ memberSettingsLocked: true });
    await expect(client(ADMIN).rpc.me()).resolves.toMatchObject({
      isDeploymentOwner: false,
      memberSettingsLocked: true,
    });
  });

  it("lets admins past the member-settings guard and stops members", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "ADMIN@example.com");
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue({
          ownerUserId: STORED_OWNER.userId,
          lockMemberSettings: true,
          shareOwnerModels: null,
        }),
      },
      user: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({
          email: where.id === ADMIN.userId ? ADMIN.email : MEMBER.email,
        })),
      },
    } as unknown as PrismaClient;
    const actor = (user: { userId: string }) => ({ userId: user.userId, isDeploymentOwner: false });
    await expect(assertMemberSettingsUnlocked(prisma, actor(ADMIN))).resolves.toBeUndefined();
    await expect(assertMemberSettingsUnlocked(prisma, actor(MEMBER))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
