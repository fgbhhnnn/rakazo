import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { withContentEncryption } from "./content-encryption.js";
import { ContentKeyRing, LocalKeyProvider } from "./content-keys.js";
import { preparedEventArgs, withPreparedEventWrite } from "./event-preparation.js";
import { appendEvent } from "./events.js";
import { PrismaClient } from "./generated/prisma/client.js";

const pool = new Pool({ connectionString: "postgres://offline:offline@127.0.0.1:9/offline" });
afterAll(() => pool.end());

function harness(encryptWrites = true, conflicts = 0) {
  let inTransaction = false;
  const keyAccess = vi.fn(() => {
    expect(inTransaction).toBe(false);
  });
  const ring = new ContentKeyRing(
    new LocalKeyProvider([{ id: "test", key: randomBytes(32) }]),
    {
      forSpace: async () => {
        keyAccess();
        return [];
      },
      insert: async (record) => {
        keyAccess();
        return record;
      },
      byId: async () => {
        throw new Error("unexpected key lookup inside write");
      },
      rowContext: async () => {
        throw new Error("unexpected context lookup");
      },
      sampleByMasterKey: async () => [],
    },
    { encryptWrites },
  );
  const writes: Record<string, unknown>[] = [];
  const readKey = ring.byId.bind(ring);
  const byId = vi.spyOn(ring, "byId").mockImplementation(async (id) => {
    expect(inTransaction).toBe(false);
    return readKey(id);
  });
  const client = withContentEncryption(
    new PrismaClient({ adapter: new PrismaPg(pool) }),
    ring,
  ).$extends({
    query: {
      $allModels: {
        async $allOperations({ model, args }) {
          if (model === "Thread") return { nextEventSeq: 3 };
          if (model !== "Event") throw new Error(`Unexpected model: ${model}`);
          const data = (args as { data: Record<string, unknown> }).data;
          writes.push(structuredClone(data));
          return { ...data, createdAt: new Date(0) };
        },
      },
    },
  });
  const transaction = vi.fn(async (callback: (tx: unknown) => unknown) => {
    inTransaction = true;
    try {
      const result = await callback(client);
      if (conflicts-- > 0) throw Object.assign(new Error("conflict"), { code: "P2034" });
      return result;
    } finally {
      inTransaction = false;
    }
  });
  const prisma = new Proxy(client, {
    get(target, prop, receiver) {
      return prop === "$transaction" ? transaction : Reflect.get(target, prop, receiver);
    },
  }) as unknown as PrismaClient;
  return { prisma, writes, keyAccess, byId, transaction };
}
const input = {
  spaceId: "space",
  threadId: "thread",
  botId: "bot",
  type: "agent.tool.called" as const,
  payload: { name: "read", text: "secret content" },
};

describe("prepared event writes", () => {
  it("does not open a transaction when key preparation fails", async () => {
    const h = harness();
    h.keyAccess.mockImplementation(() => {
      throw new Error("key service unavailable");
    });
    await expect(appendEvent(h.prisma, input)).rejects.toThrow("key service unavailable");
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
  it("loads keys and seals before the transaction, storing ciphertext and returning plaintext", async () => {
    const h = harness();
    const event = await appendEvent(h.prisma, input);
    expect(event.payload).toEqual(input.payload);
    expect(JSON.stringify(h.writes)).not.toContain("secret content");
    expect(h.writes[0]?.payload).toHaveProperty("$sealed");
    expect(h.keyAccess).toHaveBeenCalled();
    expect(h.byId).toHaveBeenCalled();
    expect(event.seq).toBe(2);
  });
  it("reuses prepared ciphertext across a rolled-back transaction retry", async () => {
    const h = harness(true, 1);
    expect((await appendEvent(h.prisma, input)).payload).toEqual(input.payload);
    expect(h.transaction).toHaveBeenCalledTimes(2);
    expect(h.writes[0]).toEqual(h.writes[1]);
  });
  it("keeps encryption-off behavior and sanitizes invalid Unicode before preparing", async () => {
    const h = harness(false);
    const event = await appendEvent(h.prisma, { ...input, payload: { text: "hello\u0000\ud800" } });
    expect(event.payload).toEqual(h.writes[0]?.payload);
    expect(JSON.stringify(event.payload)).not.toContain("\\u0000");
    expect(h.keyAccess).not.toHaveBeenCalled();
  });
  it("cannot bypass encryption outside its private preparation scope or for a different row", async () => {
    const h = harness();
    await withPreparedEventWrite(h.prisma, input, async (data) => {
      const args = { data };
      expect(preparedEventArgs("Event", "create", args)).toBe(args);
      expect(
        preparedEventArgs("Event", "create", { data: { ...data, threadId: "other" } }),
      ).toBeUndefined();
      expect(
        preparedEventArgs("Event", "create", { data: { ...data, payload: {} } }),
      ).toBeUndefined();
      expect(preparedEventArgs("Message", "create", args)).toBeUndefined();
      return {
        id: String(data?.id),
        spaceId: input.spaceId,
        threadId: input.threadId,
        payload: data?.payload,
      };
    });
    expect(preparedEventArgs("Event", "create", { data: h.writes[0] })).toBeUndefined();
  });
});
