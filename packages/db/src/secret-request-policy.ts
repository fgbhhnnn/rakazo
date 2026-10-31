import type { LoginFailureReason, MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "./client.js";

/** Shared policy knob; callers/tests can supply another interval without provider settings. */
export const SECRET_REQUEST_REASK_WINDOW_MS = 30 * 60 * 1000;

type SecretAsk = Extract<MessageBlock, { kind: "ask" }>;
type PolicyClient = Pick<PrismaClient, "run" | "message" | "event">;
export type SecretRequestPolicyInput = {
  spaceId: string;
  threadId: string;
  runId: string;
  userId: string;
  ask: SecretAsk;
  failureReason?: LoginFailureReason;
  now?: Date;
  windowMs?: number;
};

export class SecretRequestBlockedError extends Error {
  constructor(readonly code: "recently_answered" | "dismissed") {
    super(
      code === "recently_answered"
        ? "This credential was recently supplied. Use the existing credential and report the actual login failure reason to the user. Request a replacement only after the site rejects the password (failureReason: password_rejected)."
        : "The user dismissed this credential card. Do not issue another card for the same login in this session; report the actual obstacle and wait for the user.",
    );
  }
}

function protectedCredential(ask: SecretAsk): boolean {
  return (
    ask.input === "secret" && Boolean(ask.credential || (ask.purpose && ask.purpose !== "otp"))
  );
}

/** Identity survives a renamed card, path changes, or switching a login to a command value. */
export function sameSecretRequest(a: SecretAsk, b: SecretAsk): boolean {
  if (!protectedCredential(a) || !protectedCredential(b)) return false;
  const left = a.credential;
  const right = b.credential;
  if (left && right) {
    if (left.name === right.name) return true;
    if (left.origin && right.origin) return left.origin === right.origin;
  }
  return Boolean(a.purpose && a.purpose !== "otp" && a.purpose === b.purpose);
}

function asks(blocks: unknown): SecretAsk[] {
  return (MessageBlockSchema.array().safeParse(blocks).data ?? []).filter(
    (block): block is SecretAsk => block.kind === "ask",
  );
}

/** Uses answer-event time, not card creation time: a card can wait days for an answer. */
export async function checkSecretRequestPolicy(
  client: PolicyClient,
  input: SecretRequestPolicyInput,
) {
  if (!protectedCredential(input.ask)) return { pending: [] };
  const runs = await client.run.findMany({
    where: { spaceId: input.spaceId, threadId: input.threadId, userId: input.userId },
    select: { id: true },
  });
  const runIds = runs.map(({ id }) => id);
  if (!runIds.length) return { pending: [] };
  const cutoff = new Date(
    (input.now ?? new Date()).getTime() - (input.windowMs ?? SECRET_REQUEST_REASK_WINDOW_MS),
  );
  const updates = await client.event.findMany({
    where: {
      spaceId: input.spaceId,
      threadId: input.threadId,
      runId: { in: runIds },
      type: "thread.message.updated",
      createdAt: { gte: cutoff },
    },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  for (const { payload } of updates) {
    const blocks = (payload as { blocks?: unknown } | null)?.blocks;
    for (const ask of asks(blocks)) {
      if (ask.status !== "answered" || ask.superseded || !sameSecretRequest(ask, input.ask))
        continue;
      if (ask.dismissed) throw new SecretRequestBlockedError("dismissed");
      if (input.failureReason !== "password_rejected")
        throw new SecretRequestBlockedError("recently_answered");
    }
  }
  const messages = await client.message.findMany({
    where: {
      threadId: input.threadId,
      runId: { in: runIds },
      role: "bot",
      blocks: { array_contains: [{ kind: "ask" }] },
    },
    select: { id: true, runId: true, blocks: true },
  });
  // A dismissed card in this run remains dismissed even if the run lasts longer than the window.
  if (
    messages.some(
      (message) =>
        message.runId === input.runId &&
        asks(message.blocks).some(
          (ask) => ask.dismissed && !ask.superseded && sameSecretRequest(ask, input.ask),
        ),
    )
  )
    throw new SecretRequestBlockedError("dismissed");
  return {
    pending: messages.filter((message) =>
      asks(message.blocks).some(
        (ask) => ask.status !== "answered" && sameSecretRequest(ask, input.ask),
      ),
    ),
  };
}

/** Called under pauseRunForInput's thread lock, shared with answerRunInput. */
export async function supersedeSecretRequests(
  tx: Prisma.TransactionClient,
  input: SecretRequestPolicyInput,
  publish: (messageId: string, blocks: MessageBlock[]) => Promise<unknown>,
): Promise<string[]> {
  const { pending } = await checkSecretRequestPolicy(tx, input);
  const resumed: string[] = [];
  for (const message of pending) {
    const blocks = MessageBlockSchema.array()
      .parse(message.blocks)
      .map((block) =>
        block.kind === "ask" && block.status !== "answered" && sameSecretRequest(block, input.ask)
          ? {
              ...block,
              status: "answered" as const,
              answer: "",
              dismissed: true as const,
              superseded: true as const,
            }
          : block,
      );
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    await publish(message.id, blocks);
    if (!message.runId || message.runId === input.runId) continue;
    const result = {
      ok: false,
      superseded: true,
      note: "Use the current credential card in this chat. Do not issue another card.",
    };
    await tx.externalEffect.updateMany({
      where: { runId: message.runId, kind: "request_secret", status: "intended" },
      data: { status: "completed", result },
    });
    const updated = await tx.run.updateMany({
      where: { id: message.runId, status: "waiting_input" },
      data: { status: "queued", leaseOwner: null, leaseExpiresAt: null },
    });
    if (updated.count) resumed.push(message.runId);
  }
  return [...new Set(resumed)];
}
