import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  getSavedPasswordSettings,
  updateSavedPasswordSettings,
} from "./saved-password-settings.js";

describe("saved-password storage", () => {
  it("defaults off at both the schema and database boundary", async () => {
    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    expect(schema).toMatch(/allowBotPasswordReveal\s+Boolean\s+@default\(false\)/);
    const prisma = { user: { findUnique: vi.fn(async () => ({})) } } as unknown as PrismaClient;
    expect(await getSavedPasswordSettings(prisma, "user")).toEqual({
      allowBotPasswordReveal: false,
    });
  });
  it("writes only the explicit consent field", async () => {
    const update = vi.fn(async () => ({ allowBotPasswordReveal: true }));
    await updateSavedPasswordSettings({ user: { update } } as unknown as PrismaClient, "user", {
      allowBotPasswordReveal: true,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: "user" },
      data: { allowBotPasswordReveal: true },
      select: { allowBotPasswordReveal: true },
    });
  });
});
