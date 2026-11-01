import { ASK_TEAMMATE_TOOL_NAME } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const askTeammate = vi.fn();
vi.mock("./group-consult.js", () => ({
  askTeammate: (...args: unknown[]) => askTeammate(...args),
}));

const { askTeammateTool, askTools } = await import("./run-tools-ask.js");

function harness(groupId: string | null) {
  const state = { handedOff: false, askedTeammate: false, handoffTargets: [] as string[] };
  const ctx = { deps: {}, run: { id: "r1" }, thread: { groupId }, secrets: [], state };
  const call = { args: { bot_id: "be", question: "登录接口的字段？" }, finish: (r: unknown) => r };
  const handler = askTools[ASK_TEAMMATE_TOOL_NAME] as (ctx: any, call: any) => Promise<unknown>;
  return { state, run: () => handler(ctx, call) };
}

describe("ask_teammate tool", () => {
  beforeEach(() => askTeammate.mockReset());

  it("is a question, not a handoff", () => {
    expect(askTeammateTool.description).toContain("keep your own stage");
    expect(askTeammateTool.description).toContain("use handoff_to_bot instead");
    expect((askTeammateTool.inputSchema as { required: string[] }).required).toEqual(["question"]);
  });

  it("ends the turn and records the target once the question is posted", async () => {
    askTeammate.mockResolvedValue({ ok: true, botId: "be", name: "团队-后端" });
    const h = harness("g1");
    await expect(h.run()).resolves.toMatchObject({ ok: true });
    expect(h.state).toEqual({ handedOff: true, askedTeammate: true, handoffTargets: ["be"] });
    expect(askTeammate.mock.calls[0]?.[2]).toBe("g1");
  });

  it("leaves the turn running when the question is refused or outside a group", async () => {
    askTeammate.mockResolvedValue({ error: "pair_limit" });
    const refused = harness("g1");
    await refused.run();
    expect(refused.state).toEqual({ handedOff: false, askedTeammate: false, handoffTargets: [] });

    const direct = harness(null);
    await expect(direct.run()).resolves.toEqual({
      error: "ask_teammate only works in a group chat",
    });
    expect(askTeammate).toHaveBeenCalledTimes(1);
  });
});
