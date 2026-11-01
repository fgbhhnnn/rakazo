import { AsyncLocalStorage } from "node:async_hooks";
import { sanitizeJsonValue } from "@rakazo/core";
import { contentEncryptionOf } from "./content-encryption.js";
import type { AppendEventInput } from "./events.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { createRowId } from "./row-id.js";

type Data = Record<string, unknown>;
const preparedWrite = new AsyncLocalStorage<Data>();

/** Prepare encryption (including remote key unwrap) before acquiring a transaction/row lock. */
export async function withPreparedEventWrite<
  T extends { id: string; spaceId: string; threadId: string; payload: unknown },
>(prisma: PrismaClient, input: AppendEventInput, write: (data?: Data) => Promise<T>): Promise<T> {
  // System-scoped clients wrap even synchronous accessors in a promise.
  const encryption = await contentEncryptionOf(prisma);
  if (!encryption) return write();
  const data: Data = {
    id: createRowId(),
    spaceId: input.spaceId,
    threadId: input.threadId,
    payload: sanitizeJsonValue(input.payload),
  };
  const prepared = await encryption.prepareEvent(data);
  const event = await preparedWrite.run(prepared, () => write(prepared));
  // Opening the created row can also unwrap a key. Do it after the commit releases its locks.
  await encryption.openRows("Event", [event]);
  return event;
}

/** Only the exact internally prepared row may bypass sealing; serialized input cannot opt out. */
export function preparedEventArgs(model: string, operation: string, args: Data): Data | undefined {
  const prepared = preparedWrite.getStore();
  if (model !== "Event" || operation !== "create" || !prepared) return;
  const data = args.data as Data | undefined;
  if (
    data &&
    data.id === prepared.id &&
    data.spaceId === prepared.spaceId &&
    data.threadId === prepared.threadId &&
    JSON.stringify(data.payload) === JSON.stringify(prepared.payload)
  )
    return args;
}
