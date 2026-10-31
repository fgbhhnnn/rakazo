import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { pauseRunForInput } from "./events.js";

const ask: MessageBlock = {
  kind: "ask",
  input: "secret",
  text: "Login",
  purpose: "password",
  status: "pending",
  credential: { name: "site-login", origin: "https://example.test", auth: { type: "login" } },
};

/** Serializes the real card transaction as Postgres's existing thread lock does. */
function fixture() {
  type Run = {
    id: string;
    status: string;
    userId: string;
    threadId: string;
    firstResponseAt: Date;
  };
  let runs: Run[] = ["one", "two"].map((id) => ({
    id,
    status: "running",
    userId: "user",
    threadId: "thread",
    firstResponseAt: new Date(),
  }));
  let messages: Array<{ id: string; runId: string; blocks: MessageBlock[] }> = [];
  let events: Array<{ type: string; payload: unknown; seq: number; createdAt: Date }> = [];
  let messageSeq = 0;
  let eventSeq = 0;
  const tx = {
    $queryRaw: vi.fn(async (..._args: unknown[]) => []),
    run: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        runs.find((run) => run.id === where.id),
      ),
      findMany: vi.fn(async () => runs),
      findFirst: vi.fn(async () => runs.find((run) => run.status === "queued") ?? null),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; status?: string }; data: Partial<Run> }) => {
          const run = runs.find(
            (item) => item.id === where.id && (!where.status || where.status === item.status),
          );
          if (!run) return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        },
      ),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    computerExecutionLease: { updateMany: vi.fn(async () => ({ count: 1 })) },
    externalEffect: { updateMany: vi.fn(async () => ({ count: 1 })) },
    steeringMessage: { findMany: vi.fn(async () => []) },
    thread: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        nextMessageSeq: data.nextMessageSeq ? ++messageSeq : messageSeq,
        nextEventSeq: data.nextEventSeq ? ++eventSeq : eventSeq,
      })),
    },
    message: {
      findMany: vi.fn(async () => messages),
      create: vi.fn(async ({ data }: { data: { runId: string; blocks: MessageBlock[] } }) => {
        const message = { id: `message-${messageSeq}`, ...data };
        messages.push(message);
        return message;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { blocks: MessageBlock[] } }) =>
          Object.assign(messages.find((message) => message.id === where.id)!, data),
      ),
    },
    event: {
      findMany: vi.fn(async () =>
        events.filter((event) => event.type === "thread.message.updated"),
      ),
      create: vi.fn(async ({ data }: { data: { type: string; payload: unknown; seq: number } }) => {
        const event = { ...data, createdAt: new Date() };
        events.push(event);
        return event;
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  let transaction: Promise<unknown> = Promise.resolve();
  const prisma = {
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => {
      const next = transaction.then(async () => {
        const snapshot = structuredClone({ runs, messages, events });
        try {
          return await work(tx);
        } catch (error) {
          ({ runs, messages, events } = snapshot);
          throw error;
        }
      });
      transaction = next.catch(() => undefined);
      return next;
    },
  } as unknown as PrismaClient;
  const pause = (runId: string) =>
    pauseRunForInput(prisma, {
      runId,
      botId: "bot",
      spaceId: "space",
      threadId: "thread",
      attemptId: `attempt-${runId}`,
      leaseOwner: "worker",
      leaseFence: 1,
      secretRequest: { userId: "user" },
      blocks: [ask],
    });
  return { pause, tx, state: () => ({ runs, messages, events }) };
}

describe("secure cards through pauseRunForInput", () => {
  it("leaves one actionable card when two runs request the same login concurrently", async () => {
    const { pause, state, tx } = fixture();
    const results = await Promise.all([pause("one"), pause("two")]);
    expect(results).toEqual([
      { continuationRunId: null },
      { continuationRunId: null, supersededSecretRunIds: ["one"] },
    ]);
    const { messages, runs, events } = state();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.blocks[0]).toMatchObject({
      status: "answered",
      dismissed: true,
      superseded: true,
    });
    expect(messages[1]?.blocks[0]).toMatchObject({ status: "pending" });
    expect(runs.map((run) => run.status)).toEqual(["queued", "waiting_input"]);
    expect(events.find((event) => event.type === "thread.message.updated")?.payload).toMatchObject({
      messageId: messages[0]?.id,
    });
    const lockText = tx.$queryRaw.mock.calls.map((args) => String(args[0]));
    expect(
      lockText.filter((sql) => sql.includes("threads") && sql.includes("FOR UPDATE")),
    ).toHaveLength(2);
  });

  it("rechecks a dismissal inside the card transaction and rolls back the pause", async () => {
    const { pause, tx, state } = fixture();
    tx.event.findMany.mockResolvedValueOnce([
      {
        type: "thread.message.updated",
        seq: 1,
        createdAt: new Date(),
        payload: { blocks: [{ ...ask, status: "answered", dismissed: true }] },
      },
    ]);
    await expect(pause("two")).rejects.toMatchObject({ code: "dismissed" });
    expect(state().runs.find((run) => run.id === "two")?.status).toBe("running");
    expect(state().messages).toEqual([]);
    expect(tx.message.create).not.toHaveBeenCalled();
  });
});
