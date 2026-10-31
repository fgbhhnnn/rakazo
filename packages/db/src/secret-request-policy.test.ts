import type { MessageBlock } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  checkSecretRequestPolicy,
  SECRET_REQUEST_REASK_WINDOW_MS,
  SecretRequestBlockedError,
  sameSecretRequest,
  supersedeSecretRequests,
} from "./secret-request-policy.js";

type Ask = Extract<MessageBlock, { kind: "ask" }>;
const ask: Ask = {
  kind: "ask",
  text: "Site login",
  input: "secret",
  purpose: "password",
  status: "pending",
  credential: { name: "site-login", origin: "https://example.test", auth: { type: "login" } },
};
const now = new Date("2026-10-31T10:00:00Z");
const input = { spaceId: "space", threadId: "thread", runId: "current", userId: "user", ask, now };

function fixture(
  options: {
    updates?: Array<{ blocks: Ask[]; createdAt: Date }>;
    messages?: Array<{ id: string; runId: string; blocks: MessageBlock[] }>;
  } = {},
) {
  const messages = options.messages ?? [];
  const tx = {
    run: {
      findMany: vi.fn(async () => [{ id: "old" }, { id: "current" }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    event: {
      findMany: vi.fn(async ({ where }: { where: { createdAt: { gte: Date } } }) =>
        (options.updates ?? [])
          .filter((update) => update.createdAt >= where.createdAt.gte)
          .map((update) => ({ payload: { blocks: update.blocks } })),
      ),
    },
    message: {
      findMany: vi.fn(async () => messages),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: { blocks: MessageBlock[] } }) => {
          Object.assign(messages.find((message) => message.id === where.id)!, data);
        },
      ),
    },
    externalEffect: { updateMany: vi.fn() },
  };
  return { tx, client: tx as never, messages };
}
const answered = { ...ask, status: "answered" as const, answer: "" };

describe("credential request identity", () => {
  it("matches names, origins, renamed cards and login-to-command workarounds", () => {
    expect(sameSecretRequest(ask, { ...ask, text: "Corrected password" })).toBe(true);
    expect(
      sameSecretRequest(ask, { ...ask, credential: { ...ask.credential!, name: "renamed" } }),
    ).toBe(true);
    expect(
      sameSecretRequest(ask, {
        ...ask,
        credential: { name: "command-password", origin: "", auth: { type: "command" } },
      }),
    ).toBe(true);
    expect(sameSecretRequest(ask, { ...ask, credential: undefined })).toBe(true);
  });
  it("matches API-key requests by purpose when no site identity is available", () => {
    const key: Ask = { ...ask, purpose: "api_key", credential: undefined };
    expect(sameSecretRequest(key, { ...key, text: "Save the corrected key" })).toBe(true);
    expect(sameSecretRequest(key, { ...key, purpose: "otp" })).toBe(false);
  });
  it("does not conflate other sites or one-use codes", () => {
    expect(
      sameSecretRequest(ask, {
        ...ask,
        credential: { ...ask.credential!, name: "other", origin: "https://other.example.test" },
      }),
    ).toBe(false);
    expect(sameSecretRequest(ask, { ...ask, purpose: "otp", credential: undefined })).toBe(false);
  });
});

describe("recently answered credential guard", () => {
  it.each([
    undefined,
    "no_page_browser",
    "field_not_found",
    "captcha_or_2fa",
    "site_error",
    "unknown",
  ] as const)("blocks another card when reason is %s", async (failureReason) => {
    const { client } = fixture({ updates: [{ blocks: [answered], createdAt: now }] });
    await expect(
      checkSecretRequestPolicy(client, { ...input, failureReason }),
    ).rejects.toMatchObject({ code: "recently_answered" });
  });
  it("allows a replacement only for password rejection", async () => {
    const { client } = fixture({ updates: [{ blocks: [answered], createdAt: now }] });
    await expect(
      checkSecretRequestPolicy(client, { ...input, failureReason: "password_rejected" }),
    ).resolves.toEqual({ pending: [] });
  });
  it("uses answer time and allows re-asking outside the configurable window", async () => {
    const { client, tx } = fixture({
      updates: [
        {
          blocks: [answered],
          createdAt: new Date(now.getTime() - SECRET_REQUEST_REASK_WINDOW_MS - 1),
        },
      ],
    });
    await expect(checkSecretRequestPolicy(client, input)).resolves.toEqual({ pending: [] });
    await expect(
      checkSecretRequestPolicy(client, { ...input, windowMs: SECRET_REQUEST_REASK_WINDOW_MS + 2 }),
    ).rejects.toBeInstanceOf(SecretRequestBlockedError);
    expect(tx.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: "thread.message.updated",
          threadId: "thread",
          spaceId: "space",
          runId: { in: ["old", "current"] },
        }),
      }),
    );
    expect(tx.run.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId: "space", threadId: "thread", userId: "user" } }),
    );
  });
  it("does not block a different site", async () => {
    const { client } = fixture({
      updates: [
        {
          blocks: [
            {
              ...answered,
              credential: {
                ...ask.credential!,
                name: "other",
                origin: "https://other.example.test",
              },
            },
          ],
          createdAt: now,
        },
      ],
    });
    await expect(checkSecretRequestPolicy(client, input)).resolves.toEqual({ pending: [] });
  });
  it("does not query credential history for connector codes", async () => {
    const { client, tx } = fixture();
    await expect(
      checkSecretRequestPolicy(client, {
        ...input,
        ask: { ...ask, credential: undefined, purpose: "otp" },
      }),
    ).resolves.toEqual({ pending: [] });
    expect(tx.run.findMany).not.toHaveBeenCalled();
  });
});

describe("dismissal and superseding", () => {
  it.each([undefined, "password_rejected"] as const)(
    "respects recent dismissal even with %s",
    async (failureReason) => {
      const { client } = fixture({
        updates: [{ blocks: [{ ...answered, dismissed: true }], createdAt: now }],
      });
      await expect(
        checkSecretRequestPolicy(client, { ...input, failureReason }),
      ).rejects.toMatchObject({ code: "dismissed" });
    },
  );
  it("respects a dismissal for the full run even outside the window", async () => {
    const { client } = fixture({
      messages: [{ id: "dismissed", runId: "current", blocks: [{ ...answered, dismissed: true }] }],
    });
    await expect(checkSecretRequestPolicy(client, input)).rejects.toMatchObject({
      code: "dismissed",
    });
  });
  it("closes only matching pending cards, publishes updates and resumes superseded waiters", async () => {
    const unrelated: Ask = {
      ...ask,
      credential: { ...ask.credential!, name: "other", origin: "https://other.example.test" },
    };
    const { client, messages, tx } = fixture({
      messages: [
        { id: "one", runId: "old", blocks: [ask, { kind: "text", text: "Retain this" }] },
        { id: "two", runId: "current", blocks: [ask] },
        { id: "other", runId: "old", blocks: [unrelated] },
      ],
    });
    const publish = vi.fn();
    expect(await supersedeSecretRequests(client, input, publish)).toEqual(["old"]);
    for (const message of messages.slice(0, 2)) {
      expect(message.blocks[0]).toMatchObject({
        status: "answered",
        dismissed: true,
        superseded: true,
      });
      expect(MessageBlockSchema.array().safeParse(message.blocks).success).toBe(true);
    }
    expect(messages[0]?.blocks[1]).toEqual({ kind: "text", text: "Retain this" });
    expect(messages[2]?.blocks[0]).toEqual(unrelated);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(tx.externalEffect.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.run.updateMany).toHaveBeenCalledWith({
      where: { id: "old", status: "waiting_input" },
      data: { status: "queued", leaseOwner: null, leaseExpiresAt: null },
    });
    // The next card creation sees no matching pending cards.
    expect(await supersedeSecretRequests(client, input, publish)).toEqual([]);
  });
  it("does not mistake a superseded card for a dismissal or a submitted credential", async () => {
    const { client } = fixture({
      updates: [{ blocks: [{ ...answered, dismissed: true, superseded: true }], createdAt: now }],
    });
    await expect(checkSecretRequestPolicy(client, input)).resolves.toEqual({ pending: [] });
  });
});
