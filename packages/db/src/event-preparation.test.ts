import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { withContentEncryption } from "./content-encryption.js";
import { ContentKeyRing, LocalKeyProvider } from "./content-keys.js";
import { preparedEventArgs, withPreparedEventWrite } from "./event-preparation.js";
import { appendEvent } from "./events.js";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { asSystem } from "./row-security.js";

const pool = new Pool({ connectionString: "postgres://offline:offline@127.0.0.1:9/offline" });
afterAll(() => pool.end());

function harness(encryptWrites = true) {
  let writing = false;
  const keyAccess = vi.fn(() => {
    expect(writing).toBe(false);
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
    expect(writing).toBe(false);
    return readKey(id);
  });
  const client = withContentEncryption(new PrismaClient({ adapter: new PrismaPg(pool) }), ring);
  const transaction = vi.fn(() => {
    throw new Error("events must use one autocommit statement");
  });
  const raw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    writing = true;
    try {
      const sql = Prisma.sql(strings, ...values);
      const payload = sql.values.find(
        (value) => typeof value === "string" && value.startsWith("{"),
      );
      if (typeof payload !== "string") throw new Error("missing event payload");
      writes.push({ payload: JSON.parse(payload) });
      return [{ id: "event", seq: 2, createdAt: new Date(0), runId: null, firstResponse: false }];
    } finally {
      writing = false;
    }
  });
  const prisma = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "$transaction") return transaction;
      if (prop === "$queryRaw") return raw;
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as PrismaClient;
  return { prisma, writes, keyAccess, byId, transaction, raw };
}
const input = {
  spaceId: "space",
  threadId: "thread",
  botId: "bot",
  type: "agent.tool.called" as const,
  payload: { name: "read", text: "secret content" },
};

describe("prepared event writes", () => {
  it("prepares encrypted events through a system-scoped client", async () => {
    const h = harness();
    const event = await appendEvent(asSystem(h.prisma), input);
    expect(event.payload).toEqual(input.payload);
    expect(h.writes[0]?.payload).toHaveProperty("$sealed");
    expect(JSON.stringify(h.writes)).not.toContain("secret content");
    expect(h.keyAccess).toHaveBeenCalled();
    expect(h.byId).not.toHaveBeenCalled();
    expect(h.raw).toHaveBeenCalledOnce();
    expect(h.transaction).not.toHaveBeenCalled();
  });
  it("keeps key preparation failures outside a system-scoped transaction", async () => {
    const h = harness();
    h.keyAccess.mockImplementation(() => {
      throw new Error("key service unavailable");
    });
    await expect(appendEvent(asSystem(h.prisma), input)).rejects.toThrow("key service unavailable");
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
  it("does not open a transaction when key preparation fails", async () => {
    const h = harness();
    h.keyAccess.mockImplementation(() => {
      throw new Error("key service unavailable");
    });
    await expect(appendEvent(h.prisma, input)).rejects.toThrow("key service unavailable");
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
  it("loads keys before the autocommit write, storing ciphertext and returning plaintext", async () => {
    const h = harness();
    const event = await appendEvent(h.prisma, input);
    expect(event.payload).toEqual(input.payload);
    expect(JSON.stringify(h.writes)).not.toContain("secret content");
    expect(h.writes[0]?.payload).toHaveProperty("$sealed");
    expect(h.keyAccess).toHaveBeenCalled();
    expect(h.byId).not.toHaveBeenCalled();
    expect(h.raw).toHaveBeenCalledOnce();
    expect(h.transaction).not.toHaveBeenCalled();
    expect(event.seq).toBe(2);
  });
  it("keeps a failed autocommit write encrypted when its caller retries", async () => {
    const h = harness();
    h.raw.mockRejectedValueOnce(new Error("write failed"));
    await expect(appendEvent(h.prisma, input)).rejects.toThrow("write failed");
    expect(h.writes).toEqual([]);
    expect((await appendEvent(h.prisma, input)).payload).toEqual(input.payload);
    expect(h.raw).toHaveBeenCalledTimes(2);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.writes[0]?.payload).toHaveProperty("$sealed");
    expect(JSON.stringify(h.writes)).not.toContain("secret content");
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
