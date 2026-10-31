import type { ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { OFFICE_ATTACHMENT_TYPES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createOwnedArtifact } from "./artifacts.js";

const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "owner@example.com",
  isDeploymentOwner: false,
};

async function storedType(name: string, mimeType: string) {
  const reachedStorage = new Error("reached storage");
  const put = vi.fn().mockRejectedValue(reachedStorage);
  const deps = { prisma: {} as PrismaClient, artifacts: { put } as unknown as ArtifactStore };
  await expect(
    createOwnedArtifact(deps, actor, { botId: "bot-1", name, mimeType, contentBase64: "UEsDBA==" }),
  ).rejects.toBe(reachedStorage);
  return (put.mock.calls[0]![0] as { mimeType: string }).mimeType;
}

describe("Office uploads", () => {
  it.each(Object.entries(OFFICE_ATTACHMENT_TYPES))(
    "accepts %s and stores it as %s",
    async (extension, mimeType) => {
      expect(await storedType(`report${extension}`, mimeType)).toBe(mimeType);
      expect(await storedType(`report${extension}`, "application/octet-stream")).toBe(mimeType);
      expect(await storedType(`report${extension}`, "")).toBe(mimeType);
    },
  );

  it("stores a CSV that Windows labelled as Excel as text/csv", async () => {
    expect(await storedType("data.csv", "application/vnd.ms-excel")).toBe("text/csv");
  });

  it("still rejects macro-enabled and unknown Office variants", async () => {
    const put = vi.fn();
    await expect(
      createOwnedArtifact(
        { prisma: {} as PrismaClient, artifacts: { put } as unknown as ArtifactStore },
        actor,
        {
          botId: "bot-1",
          name: "macro.xlsm",
          mimeType: "application/vnd.ms-excel.sheet.macroEnabled.12",
          contentBase64: "UEsDBA==",
        },
      ),
    ).rejects.toThrow("Unsupported attachment type");
    expect(put).not.toHaveBeenCalled();
  });
});
