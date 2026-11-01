import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { OFFICE_ATTACHMENT_TYPES } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { dispatcherTaskAttachments } from "./task-attachments.js";
import { listCurrentTurnFiles, materializeCurrentTurnFiles } from "./thread-artifacts.js";

const context: AdapterContext & { botId: string } = {
  operationId: "run-1",
  traceId: "run-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "worker-1",
  signal: new AbortController().signal,
};

const uploads = Object.entries(OFFICE_ATTACHMENT_TYPES).map(([extension, mimeType], index) => ({
  id: `office-${index}`,
  storageKey: `stored-${index}`,
  name: `季度报表${extension}`,
  mimeType,
  size: 4,
  extension,
}));
const blocks: MessageBlock[] = uploads.map((upload) => ({
  kind: "file",
  artifactId: upload.id,
  name: upload.name,
  mimeType: upload.mimeType,
  size: upload.size,
}));

describe("Office uploads on the worker's computer", () => {
  it("copies each Office file into the workspace under its own extension", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const deps = {
      prisma: {
        artifact: { findMany: vi.fn().mockResolvedValue(uploads) },
      } as unknown as PrismaClient,
      artifacts: { get: vi.fn().mockResolvedValue(bytes) } as unknown as ArtifactStore,
      sandbox: { writeFile } as unknown as SandboxProvider,
    };
    const files = await materializeCurrentTurnFiles(deps, blocks, {
      context,
      computer: async () => ({ id: "c1", kind: "fake", providerRef: "fake-1" }) as ComputerRef,
      computerMode: "team",
    });
    expect(files.map((file) => file.path)).toEqual(
      uploads.map((upload) => `attachments/${upload.id}${upload.extension}`),
    );
    expect(files.map((file) => file.mimeType)).toEqual(uploads.map((upload) => upload.mimeType));
    expect(writeFile).toHaveBeenCalledTimes(uploads.length);
    for (const [index, call] of writeFile.mock.calls.entries()) {
      const written = call[1] as { path: string; content: Uint8Array };
      expect(
        written.path.endsWith(`attachments/${uploads[index]!.id}${uploads[index]!.extension}`),
      ).toBe(true);
      expect(written.content).toBe(bytes);
    }
  });

  it("lists them for the prompt without starting a computer", async () => {
    const deps = {
      prisma: {
        artifact: { findMany: vi.fn().mockResolvedValue(uploads) },
      } as unknown as PrismaClient,
    };
    const files = await listCurrentTurnFiles(deps, blocks, context);
    expect(files.map((file) => file.path.split(".").pop())).toEqual([
      "xls",
      "xlsx",
      "doc",
      "docx",
      "ppt",
      "pptx",
    ]);
  });

  it("forwards an Office upload the task names to the background worker", () => {
    const xlsx = blocks[1]!;
    expect(
      dispatcherTaskAttachments({
        turn: [],
        recent: [xlsx],
        taskText: "汇总 季度报表.xlsx 的 B 列",
      }),
    ).toEqual([xlsx]);
  });
});
