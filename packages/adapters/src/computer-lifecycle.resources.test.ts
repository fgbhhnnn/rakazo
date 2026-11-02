import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "caller-1",
  botId: "bot-1",
  signal: new AbortController().signal,
} satisfies AdapterContext;

describe("Daytona computer resource tiers", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    {
      name: "deployment-admin owner",
      admins: " other@example.test, ADMIN@example.test ",
      owner: { email: "admin@example.test" },
      resources: { cpu: 8, memory: 8 },
    },
    {
      name: "ordinary owner even when the caller is an admin",
      admins: "caller@example.test",
      owner: { email: "member@example.test" },
      resources: { cpu: 2, memory: 4 },
    },
    {
      name: "owner with no configured deployment admins",
      admins: "",
      owner: { email: "admin@example.test" },
      resources: { cpu: 2, memory: 4 },
    },
    {
      name: "missing owner",
      admins: "admin@example.test",
      owner: null,
      resources: { cpu: 2, memory: 4 },
    },
  ])("passes the tier for a $name to provision", async ({ admins, owner, resources }) => {
    vi.stubEnv("RAKAZO_ADMIN_EMAILS", admins);
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-resource-tier-"));
    const ref: ComputerRef = {
      id: "sandbox-1",
      botId: "home-1",
      kind: "daytona",
      providerRef: "sandbox-1",
    };
    const findOwner = vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === "owner-1" ? owner : { email: "caller@example.test" },
    );
    const prisma = {
      user: { findUnique: findOwner },
      computer: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          ...ref,
          id: "computer-1",
          userId: "owner-1",
          homeKey: "home-1",
          scope: "dedicated",
          state: "stopped",
          updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      computerRun: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    } as unknown as PrismaClient;
    const provision = vi.fn().mockResolvedValue(ref);
    const sandbox = {
      describe: () => ({ id: "daytona" }),
      provision,
      prepare: vi.fn().mockResolvedValue(undefined),
    } as unknown as SandboxProvider;

    try {
      await expect(
        provisionComputer(
          {
            prisma,
            sandbox,
            home: {} as AgentHomeStore,
            jobs: {} as JobPublisher,
            events: {} as ThreadEvents,
            dataDir,
          },
          "computer-1",
          context,
        ),
      ).resolves.toBe(ref);

      if (admins) {
        expect(findOwner).toHaveBeenCalledExactlyOnceWith({
          where: { id: "owner-1" },
          select: { email: true },
        });
      } else {
        expect(findOwner).not.toHaveBeenCalled();
      }
      expect(provision).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ botId: "home-1", resources }),
        context,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
