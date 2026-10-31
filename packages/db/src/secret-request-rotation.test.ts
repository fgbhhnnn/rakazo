import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { checkSecretRequestPolicy, supersedeSecretRequests } from "./secret-request-policy.js";

type Ask = Extract<MessageBlock, { kind: "ask" }>;
const ask: Ask = {
  kind: "ask",
  text: "API key",
  input: "secret",
  purpose: "api_key",
  credential: {
    name: "example-api",
    origin: "https://api.example.test",
    auth: { type: "bearer" },
  },
  status: "pending",
};
const input = { spaceId: "space", threadId: "thread", userId: "user", runId: "current", ask };

function fixture(previous: Ask = ask) {
  const client = {
    run: { findMany: vi.fn(async () => [{ id: "earlier" }]) },
    event: {
      findMany: vi.fn(async () => [
        { payload: { blocks: [{ ...previous, status: "answered", answer: "" }] } },
      ]),
    },
    message: { findMany: vi.fn(async () => []) },
  };
  return client as never;
}

describe("explicit API-key rotation", () => {
  it.each([
    { type: "bearer" },
    { type: "header", name: "X-Api-Key" },
    { type: "basic", username: "demo" },
    { type: "command" },
  ] as const)("allows replacement through both policy checks (%j)", async (auth) => {
    const requested: Ask = {
      ...ask,
      credential: {
        ...ask.credential!,
        auth,
        origin: auth.type === "command" ? "" : ask.credential!.origin,
      },
    };
    const client = fixture(requested);
    const rotation = { ...input, ask: requested, replace: true };
    await expect(checkSecretRequestPolicy(client, rotation)).resolves.toEqual({ pending: [] });
    await expect(supersedeSecretRequests(client, rotation, vi.fn())).resolves.toEqual([]);
  });

  it.each([
    [
      { type: "header", name: "X-Api-Key" },
      { type: "header", name: "X-Other-Key" },
    ],
    [
      { type: "basic", username: "demo" },
      { type: "basic", username: "other" },
    ],
  ] as const)(
    "does not exempt a changed authentication destination (%j)",
    async (before, after) => {
      await expect(
        checkSecretRequestPolicy(
          fixture({ ...ask, credential: { ...ask.credential!, auth: before } }),
          {
            ...input,
            ask: { ...ask, credential: { ...ask.credential!, auth: after } },
            replace: true,
          },
        ),
      ).rejects.toMatchObject({ code: "recently_answered" });
    },
  );

  it.each([undefined, false])(
    "still blocks re-asking without replace: true (%s)",
    async (replace) => {
      await expect(
        checkSecretRequestPolicy(fixture(), { ...input, replace }),
      ).rejects.toMatchObject({
        code: "recently_answered",
      });
    },
  );

  it.each([
    { ...ask, credential: { ...ask.credential!, name: "renamed" } },
    { ...ask, credential: { ...ask.credential!, origin: "https://other.example.test" } },
    { ...ask, credential: { ...ask.credential!, auth: { type: "command" as const } } },
    { ...ask, credential: undefined },
    { ...ask, purpose: "password" as const },
  ])("does not exempt destination or purpose changes (%#)", async (requested) => {
    await expect(
      checkSecretRequestPolicy(fixture(), { ...input, ask: requested, replace: true }),
    ).rejects.toMatchObject({ code: "recently_answered" });
  });

  it.each(["field_not_found", "no_page_browser", "site_error"] as const)(
    "does not treat a login obstacle as a rotation (%s)",
    async (failureReason) => {
      await expect(
        checkSecretRequestPolicy(fixture(), { ...input, replace: true, failureReason }),
      ).rejects.toMatchObject({ code: "recently_answered" });
    },
  );

  it("keeps dismissed cards dismissed during rotation", async () => {
    await expect(
      checkSecretRequestPolicy(fixture({ ...ask, dismissed: true }), { ...input, replace: true }),
    ).rejects.toMatchObject({ code: "dismissed" });
  });

  it("cannot bypass the website-login guard by labeling it an API key", async () => {
    const login: Ask = { ...ask, credential: { ...ask.credential!, auth: { type: "login" } } };
    await expect(
      checkSecretRequestPolicy(fixture(login), { ...input, ask: login, replace: true }),
    ).rejects.toMatchObject({ code: "recently_answered" });
  });
});
