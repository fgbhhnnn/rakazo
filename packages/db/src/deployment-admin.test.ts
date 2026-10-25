import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deploymentAdminEmails,
  isDeploymentAdmin,
  ownsMemberSettings,
  ownsMemberSettingsUser,
  sharedOwnerUserId,
} from "./deployment-admin.js";
import { memberSettingsLocked, sharedModelScope } from "./member-settings.js";

const ENV = { RAKAZO_ADMIN_EMAILS: " Owner@Example.com , second@example.com,," };

describe("deployment admins from RAKAZO_ADMIN_EMAILS", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("parses a comma-separated, case-insensitive list and treats blank as unset", () => {
    expect([...(deploymentAdminEmails(ENV) ?? [])]).toEqual([
      "owner@example.com",
      "second@example.com",
    ]);
    expect(deploymentAdminEmails({})).toBeNull();
    expect(deploymentAdminEmails({ RAKAZO_ADMIN_EMAILS: " , " })).toBeNull();
  });

  it("matches any listed email regardless of case and denies everyone else", () => {
    expect(isDeploymentAdmin({ email: "OWNER@example.COM" }, ENV)).toBe(true);
    expect(isDeploymentAdmin({ email: "second@example.com" }, ENV)).toBe(true);
    expect(isDeploymentAdmin({ email: "member@example.com" }, ENV)).toBe(false);
    expect(isDeploymentAdmin({ email: null }, ENV)).toBe(false);
  });

  it("grants no server authority when unset, even to the stored owner", () => {
    expect(isDeploymentAdmin({ email: "owner@example.com" }, {})).toBe(false);
  });

  it("exempts env admins from the member lock, else falls back to the stored owner", () => {
    const admin = { userId: "u-admin", email: "owner@example.com" };
    const member = { userId: "u-member", email: "member@example.com" };
    expect(ownsMemberSettings(admin, "u-someone", ENV)).toBe(true);
    expect(ownsMemberSettings(member, "u-member", ENV)).toBe(false);
    expect(ownsMemberSettings(member, "u-member", {})).toBe(true);
    expect(ownsMemberSettings(admin, "u-someone", {})).toBe(false);
    expect(ownsMemberSettings(admin, null, {})).toBe(false);
  });

  it("looks up the email only when the env list needs it", async () => {
    const findUnique = vi.fn().mockResolvedValue({ email: "Second@Example.com" });
    const prisma = { user: { findUnique } } as never;
    await expect(ownsMemberSettingsUser(prisma, { userId: "u2" }, null, ENV)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
    await expect(ownsMemberSettingsUser(prisma, { userId: "u2" }, "u2", {})).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
    await expect(ownsMemberSettingsUser({}, { userId: "u2" }, "u2", ENV)).resolves.toBe(false);
  });

  it("shares the stored owner's models, else the first listed admin that has an account", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "u-second", email: "second@example.com" },
      { id: "u-owner", email: "OWNER@example.com" },
    ]);
    const prisma = { user: { findMany } } as never;
    await expect(sharedOwnerUserId(prisma, "u-stored", ENV)).resolves.toBe("u-stored");
    await expect(sharedOwnerUserId(prisma, null, ENV)).resolves.toBe("u-owner");
    await expect(sharedOwnerUserId(prisma, null, {})).resolves.toBeNull();
    findMany.mockResolvedValue([]);
    await expect(sharedOwnerUserId(prisma, null, ENV)).resolves.toBeNull();
  });
});

describe("member lock and shared models with RAKAZO_ADMIN_EMAILS", () => {
  afterEach(() => vi.unstubAllEnvs());

  function prisma(ownerUserId: string | null, emails: Record<string, string>) {
    return {
      deploymentSettings: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ ownerUserId, lockMemberSettings: true, shareOwnerModels: true }),
      },
      user: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
          emails[where.id] ? { email: emails[where.id] } : null,
        ),
        findMany: vi.fn(async () => Object.entries(emails).map(([id, email]) => ({ id, email }))),
      },
      userModelCredential: { count: vi.fn().mockResolvedValue(0) },
      // The admin's account-wide main model, read through the Space that follows the account.
      spaceMember: {
        findMany: vi.fn(async ({ where }: { where: { userId: string } }) => [
          { spaceId: `space-of-${where.userId}` },
        ]),
      },
      spaceSettingOverride: { findMany: vi.fn().mockResolvedValue([]) },
      userModelRoleChoice: { count: vi.fn().mockResolvedValue(1) },
    } as never;
  }

  it("locks members but never a listed admin", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "ADMIN@example.com");
    const db = prisma("u-stored", { "u-admin": "admin@example.com", "u-m": "m@example.com" });
    await expect(memberSettingsLocked(db, "u-admin")).resolves.toBe(false);
    await expect(memberSettingsLocked(db, "u-m")).resolves.toBe(true);
  });

  it("keeps the stored owner as the only exempt user when unset", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    const db = prisma("u-stored", { "u-admin": "admin@example.com" });
    await expect(memberSettingsLocked(db, "u-stored")).resolves.toBe(false);
    await expect(memberSettingsLocked(db, "u-admin")).resolves.toBe(true);
  });

  it("members borrow the admin's models when no owner is stored; admins keep their own", async () => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "admin@example.com");
    const db = prisma(null, { "u-admin": "admin@example.com", "u-m": "m@example.com" });
    await expect(sharedModelScope(db, { userId: "u-m", spaceId: "s-m" })).resolves.toEqual({
      userId: "u-admin",
      spaceId: "space-of-u-admin",
    });
    await expect(sharedModelScope(db, { userId: "u-admin", spaceId: "s-a" })).resolves.toEqual({
      userId: "u-admin",
      spaceId: "s-a",
    });
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", "");
    await expect(sharedModelScope(db, { userId: "u-m", spaceId: "s-m" })).resolves.toEqual({
      userId: "u-m",
      spaceId: "s-m",
    });
  });
});
