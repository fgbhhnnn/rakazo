import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./model-roles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-roles.js")>()),
  effectiveModelRole: vi.fn(async () => ({ provider: "openai", modelId: "gpt-test" })),
}));
vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-selection.js")>()),
  findConnectedModelCredential: vi.fn(async () => ({ id: "owner-credential" })),
  hasHostedModelCredits: vi.fn(async () => true),
}));
vi.mock("./run-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./run-model.js")>()),
  resolveModelKey: vi.fn(async () => ({ apiKey: "key" })),
}));
vi.mock("./auto-review-factory.js", () => ({
  createAutoReviewProvider: vi.fn(() => ({ review: vi.fn() })),
}));

import { effectiveModelRole } from "./model-roles.js";
import { findConnectedModelCredential } from "./model-selection.js";
import { autoReviewCheckerProvider } from "./run-auto-review.js";
import { resolveModelKey } from "./run-model.js";
import { createRunTrustLoaders } from "./run-trust.js";

const MEMBER = { userId: "member", spaceId: "member-space" };
const OWNER = { userId: "owner", spaceId: "owner-space" };

function trustLoaders(modelScope?: typeof OWNER) {
  return createRunTrustLoaders({ prisma: {} } as never, {
    run: { ...MEMBER, trigger: "user" },
    ...(modelScope ? { modelScope } : {}),
    runId: "run-1",
    botId: "bot-1",
    taskPrompt: "",
    ownerStartedRun: true,
    messagingChannelRun: false,
    sourceMessage: null,
    connectedPlugins: [],
  });
}

const reviewScope = { runId: "run-1", botId: "bot-1", threadId: "thread-1", ...MEMBER };
const checker = { provider: "openai", model: "gpt-test" } as never;
const options = { memberChecker: true, registerSecrets: () => undefined };

describe("shared model scope for approvals and Auto Review", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads the approval model role from the owner's models for a member on shared models", async () => {
    await trustLoaders(OWNER).loadApprovalModel();
    expect(effectiveModelRole).toHaveBeenCalledWith({}, OWNER, "approval", {});
  });

  it("keeps the run's own approval model role without a shared scope", async () => {
    await trustLoaders().loadApprovalModel();
    expect(effectiveModelRole).toHaveBeenCalledWith({}, MEMBER, "approval", {});
  });

  it("finds the checker connection and its key in the owner's models", async () => {
    const deps = { prisma: {}, secretStore: {} } as never;
    await autoReviewCheckerProvider(deps, { ...reviewScope, modelScope: OWNER }, options, checker);
    expect(findConnectedModelCredential).toHaveBeenCalledWith({}, {}, OWNER, "openai", "gpt-test", {
      credentialId: undefined,
    });
    expect(vi.mocked(resolveModelKey).mock.calls[0]?.slice(1, 3)).toEqual(["owner", "owner-space"]);
  });

  it("uses the run's own models when no shared scope is given", async () => {
    const deps = { prisma: {}, secretStore: {} } as never;
    await autoReviewCheckerProvider(deps, reviewScope, options, checker);
    expect(vi.mocked(findConnectedModelCredential).mock.calls[0]?.[2]).toEqual(MEMBER);
    expect(vi.mocked(resolveModelKey).mock.calls[0]?.slice(1, 3)).toEqual([
      "member",
      "member-space",
    ]);
  });
});
