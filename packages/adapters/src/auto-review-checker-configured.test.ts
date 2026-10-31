import { readFileSync } from "node:fs";
import { planActionGate } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-selection.js")>()),
  findConnectedModelCredential: vi.fn(),
}));

import { runAutoReviewCheckerConfigured } from "./auto-review-checker-configured.js";
import { findConnectedModelCredential } from "./model-selection.js";

const MEMBER = { userId: "member", spaceId: "member-space" };
const OWNER = { userId: "owner", spaceId: "owner-space" };
const deps = { prisma: {}, secretStore: {} } as never;
// The deployment's checker, as prod names it: a provider the environment holds no key for.
const checker = { provider: "openai-compatible", model: "grok-4.7" };

/** Only the owner holds a connection for the checker's provider. */
function ownerHoldsConnection() {
  vi.mocked(findConnectedModelCredential).mockImplementation(async (_prisma, _store, scope) =>
    scope.userId === OWNER.userId ? ({ id: "owner-credential" } as never) : null,
  );
}

function gate(checkerConfigured: boolean) {
  return planActionGate({
    resolved: { decision: "allow", source: "default", matchingRules: [] } as never,
    mode: "auto",
    consequential: true,
    checkerConfigured,
  });
}

const input = (modelScope: typeof OWNER, overrides: Partial<{ reviewable: boolean }> = {}) => ({
  reviewable: true,
  injectedReview: false,
  memberChecker: false,
  backups: 0,
  checker,
  modelScope,
  ...overrides,
});

describe("runAutoReviewCheckerConfigured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No checker the environment can run on its own.
    vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "openai-compatible");
    vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "grok-4.7");
    vi.stubEnv("RAKAZO_LOCAL_MODELS", "");
    vi.stubEnv("PI_DEFAULT_PROVIDER", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("judges a locked member's action on the owner's shared connection", async () => {
    ownerHoldsConnection();
    const configured = await runAutoReviewCheckerConfigured(deps, input(OWNER));
    expect(configured).toBe(true);
    expect(vi.mocked(findConnectedModelCredential).mock.calls[0]?.[2]).toEqual(OWNER);
    expect(gate(configured)).toBe("judge");
  });

  it("still asks when the run's model scope is the member's own and only the owner holds it", async () => {
    ownerHoldsConnection();
    const configured = await runAutoReviewCheckerConfigured(deps, input(MEMBER));
    expect(configured).toBe(false);
    expect(vi.mocked(findConnectedModelCredential).mock.calls[0]?.[2]).toEqual(MEMBER);
    expect(gate(configured)).toBe("ask");
  });

  it("still asks when no connection exists anywhere", async () => {
    vi.mocked(findConnectedModelCredential).mockResolvedValue(null);
    for (const scope of [OWNER, MEMBER]) {
      const configured = await runAutoReviewCheckerConfigured(deps, input(scope));
      expect(configured).toBe(false);
      expect(gate(configured)).toBe("ask");
    }
  });

  it("still asks when there is no checker model at all", async () => {
    ownerHoldsConnection();
    const configured = await runAutoReviewCheckerConfigured(deps, {
      ...input(OWNER),
      checker: null,
    });
    expect(configured).toBe(false);
    expect(findConnectedModelCredential).not.toHaveBeenCalled();
    expect(gate(configured)).toBe("ask");
  });

  it("never looks up a checker outside Auto", async () => {
    ownerHoldsConnection();
    const configured = await runAutoReviewCheckerConfigured(
      deps,
      input(OWNER, { reviewable: false }),
    );
    expect(configured).toBe(false);
    expect(findConnectedModelCredential).not.toHaveBeenCalled();
  });

  it("keeps a member's own approval model, backups or an injected reviewer configured", async () => {
    vi.mocked(findConnectedModelCredential).mockResolvedValue(null);
    for (const extra of [{ memberChecker: true }, { backups: 1 }, { injectedReview: true }]) {
      expect(await runAutoReviewCheckerConfigured(deps, { ...input(MEMBER), ...extra })).toBe(true);
    }
    expect(findConnectedModelCredential).not.toHaveBeenCalled();
  });

  it("does not need a connection when the environment runs the checker", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("RAKAZO_AUTO_REVIEW_PROVIDER", "openrouter");
    vi.stubEnv("RAKAZO_AUTO_REVIEW_MODEL", "some/model");
    vi.mocked(findConnectedModelCredential).mockResolvedValue(null);
    const configured = await runAutoReviewCheckerConfigured(deps, {
      ...input(MEMBER),
      checker: { provider: "openrouter", model: "some/model" },
    });
    expect(configured).toBe(true);
    expect(findConnectedModelCredential).not.toHaveBeenCalled();
  });
});

describe("the tool gate's checker lookup", () => {
  it("passes the run's model scope, never the run's own user", () => {
    const source = readFileSync(new URL("./run-tool-gate.ts", import.meta.url), "utf8");
    const call = source.slice(source.indexOf("await runAutoReviewCheckerConfigured("));
    const body = call.slice(0, call.indexOf("});"));
    expect(body).toContain("modelScope: ctx.modelScope,");
    expect(body).not.toMatch(/run\.userId|run\.spaceId/);
    expect(source).not.toContain("isAutoReviewCheckerConfigured(");
  });
});
