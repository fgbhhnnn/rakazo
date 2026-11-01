import { ORPCError } from "@orpc/server";
import { ApprovalRulesLockedError, type PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const locked = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  memberSettingsLocked: locked,
}));

const { approvalAnswerPermission, approvalRulesLockedError, MEMBER_SETTINGS_LOCKED_MESSAGE } =
  await import("./member-settings-guard.js");

const prisma = {} as PrismaClient;
const member = { userId: "member-1", isDeploymentOwner: false };
const owner = { userId: "owner-1", isDeploymentOwner: true };

describe("approval answers on a locked deployment", () => {
  beforeEach(() => locked.mockReset());

  it("checks the lock only for an always answer", async () => {
    locked.mockResolvedValue(true);
    expect(await approvalAnswerPermission(prisma, member, "allow")).toBeUndefined();
    expect(await approvalAnswerPermission(prisma, member, "deny")).toBeUndefined();
    expect(locked).not.toHaveBeenCalled();
    expect(await approvalAnswerPermission(prisma, member, "always")).toBe(false);
  });

  it("lets owners and unlocked members save an always rule", async () => {
    locked.mockResolvedValue(true);
    expect(await approvalAnswerPermission(prisma, owner, "always")).toBe(true);
    locked.mockResolvedValue(false);
    expect(await approvalAnswerPermission(prisma, member, "always")).toBe(true);
  });

  it("reports a refused always answer as the lock message", () => {
    const mapped = approvalRulesLockedError(new ApprovalRulesLockedError());
    expect(mapped).toBeInstanceOf(ORPCError);
    expect(mapped).toMatchObject({ code: "FORBIDDEN", message: MEMBER_SETTINGS_LOCKED_MESSAGE });
    const other = new Error("other");
    expect(approvalRulesLockedError(other)).toBe(other);
  });
});
