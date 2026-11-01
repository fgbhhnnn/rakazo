import type { MessageBlock } from "@rakazo/contracts";
import { SecretRequestBlockedError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { secretTools } from "./run-tools-secrets.js";
import { pauseSecretRequest } from "./secret-request-policy.js";

const credential = {
  name: "site-login",
  origin: "https://example.test",
  auth: { type: "login" },
} as const;
const block: MessageBlock = {
  kind: "ask",
  text: "Login",
  purpose: "password",
  input: "secret",
  credential,
  status: "answered",
  answer: "",
};

function fixture() {
  const { prisma } = fakeDatabase();
  const client = Object.assign(prisma, {
    run: { findMany: vi.fn(async () => [{ id: "earlier" }]) },
    event: { findMany: vi.fn(async () => [{ payload: { blocks: [block] } }]) },
    message: { findMany: vi.fn(async () => []) },
  });
  vi.mocked(client.vaultCredential.findFirst).mockImplementation((async (args: {
    where?: { name?: string };
  }) => (args.where?.name === credential.name ? credential : null)) as never);
  const pauseRunForInput = vi.fn();
  const load = vi.fn();
  const ctx = {
    deps: { prisma: client, secretStore: { load }, events: { pauseRunForInput } },
    run: { id: "current", threadId: "thread", botId: "bot", userId: "user", spaceId: "space" },
    runId: "current",
    computer: { pageBrowserAllowed: true },
    state: {},
  };
  const call = (args: Record<string, unknown>) =>
    secretTools.request_secret!(
      ctx as never,
      {
        args: { credential, purpose: "password", replace: true, ...args },
        finish: async (result: unknown) => result,
      } as never,
    );
  return { call, client, pauseRunForInput, load };
}

it("blocks replacement before reading a secret, writing an effect or issuing a card", async () => {
  const { call, pauseRunForInput, load } = fixture();
  expect(await call({ failureReason: "field_not_found" })).toMatchObject({
    code: "recently_answered",
    error: expect.any(String),
  });
  expect(pauseRunForInput).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});

it("allows reuse after a reported password rejection without exposing the credential", async () => {
  const { call, pauseRunForInput, load } = fixture();
  expect(await call({ failureReason: "password_rejected", replace: false })).toMatchObject({
    saved: true,
    ...credential,
  });
  expect(pauseRunForInput).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});

it("blocks renamed command requests for the same password purpose", async () => {
  const { call } = fixture();
  expect(
    await call({ credential: { name: "new-command", auth: { type: "command" } } }),
  ).toMatchObject({ code: "recently_answered" });
});

it("rejects unstructured failure reasons", async () => {
  const { call } = fixture();
  expect(await call({ failureReason: "bad password maybe" })).toMatchObject({
    error: "Invalid login failure reason.",
    reason: "unknown",
  });
});

it("advertises and validates the failure reason in the tool schema", () => {
  const tool = builtinAgentTools.find((entry) => entry.name === "request_secret")!;
  const schema = z.fromJSONSchema(tool.inputSchema);
  expect(
    schema.safeParse({
      label: "Login",
      purpose: "password",
      credential,
      replace: true,
      failureReason: "password_rejected",
    }).success,
  ).toBe(true);
  expect(
    schema.safeParse({ label: "Login", purpose: "password", credential, failureReason: "raw text" })
      .success,
  ).toBe(false);
});

describe("concurrent card creation", () => {
  it("converts an atomic policy refusal into a tool error", async () => {
    const events = {
      pauseRunForInput: vi.fn(async () => {
        throw new SecretRequestBlockedError("dismissed");
      }),
    };
    expect(await pauseSecretRequest(events as never, {} as never)).toMatchObject({
      code: "dismissed",
      error: expect.any(String),
    });
  });
  it("preserves infrastructure errors and successful pause results", async () => {
    const error = new Error("Database unavailable");
    await expect(
      pauseSecretRequest(
        {
          pauseRunForInput: async () => {
            throw error;
          },
        } as never,
        {} as never,
      ),
    ).rejects.toBe(error);
    const result = { continuationRunId: null, supersededSecretRunIds: ["old"] };
    await expect(
      pauseSecretRequest({ pauseRunForInput: async () => result } as never, {} as never),
    ).resolves.toBe(result);
  });
});

it("returns the existing credential after submission without requiring a failure report", async () => {
  const { call, pauseRunForInput } = fixture();
  expect(await call({ replace: false })).toMatchObject({ saved: true, ...credential });
  expect(pauseRunForInput).not.toHaveBeenCalled();
});
