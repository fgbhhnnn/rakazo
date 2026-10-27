import { describe, expect, it } from "vitest";
import {
  failedHandoffNotice,
  formatHandoffBrief,
  HANDOFF_CHAIN_LIMIT_NOTICE,
  handoffClaims,
  replyMentionTarget,
  unverifiedHandoffClaimNote,
} from "./group-team.js";

const team = [
  { id: "pm", name: "团队-产品" },
  { id: "fe", name: "团队-前端" },
  { id: "be", name: "团队-后端" },
  { id: "qa", name: "团队-测试" },
];

describe("replyMentionTarget", () => {
  it("routes to the first exact member mention, with Chinese text right after the name", () => {
    expect(replyMentionTarget("接口好了，@团队-前端请对接，之后@团队-测试", team, "be")?.id).toBe(
      "fe",
    );
  });

  it("never targets the bot itself or everyone", () => {
    expect(replyMentionTarget("@团队-后端 我继续", team, "be")).toBeUndefined();
    expect(replyMentionTarget("@everyone 看下", team, "be")).toBeUndefined();
    expect(replyMentionTarget("我是@团队-后端，@团队-产品确认下", team, "be")?.id).toBe("pm");
  });

  it("ignores a name that is not a complete member name", () => {
    expect(replyMentionTarget("@前端 看下", team, "be")).toBeUndefined();
    expect(replyMentionTarget("@团队-前端x", team, "be")).toBeUndefined();
  });
});

describe("handoff claims", () => {
  const others = team.filter((member) => member.id !== "pm");

  it("finds claims and the members they name, by full or short role name", () => {
    expect(handoffClaims("已交给后端处理。然后我们看结果。", others)).toEqual([
      { sentence: "已交给后端处理。", memberIds: ["be"] },
    ]);
    expect(handoffClaims("我已把需求转交给@团队-前端", others)[0]?.memberIds).toEqual(["fe"]);
    expect(handoffClaims("I've handed it off to someone", others)).toHaveLength(1);
  });

  it("does not treat plans or questions as claims", () => {
    expect(handoffClaims("接下来交给后端。", others)).toEqual([]);
    expect(handoffClaims("要不要已交给后端？", others)).toEqual([]);
    expect(handoffClaims("需求已完成。", others)).toEqual([]);
  });

  it("notes a claim with no matching handoff this turn", () => {
    expect(unverifiedHandoffClaimNote("已交给后端。", others, [])).toBe(
      "（未实际交接给 团队-后端）",
    );
    expect(unverifiedHandoffClaimNote("已交给后端。", others, ["fe"])).toBe(
      "（未实际交接给 团队-后端）",
    );
    expect(unverifiedHandoffClaimNote("已转交，等结果。", others, [])).toBe("（未实际交接）");
    expect(unverifiedHandoffClaimNote("已通知前端和后端。", others, ["fe"])).toBe(
      "（未实际交接给 团队-后端）",
    );
  });

  it("accepts a claim backed by a real handoff", () => {
    expect(unverifiedHandoffClaimNote("已交给@团队-后端。", others, ["be"])).toBeUndefined();
    expect(unverifiedHandoffClaimNote("已转交，等结果。", others, ["be"])).toBeUndefined();
    expect(unverifiedHandoffClaimNote("好的，我来做。", others, [])).toBeUndefined();
  });
});

describe("handoff brief and notices", () => {
  it("formats only the fields given", () => {
    expect(
      formatHandoffBrief({
        message: "请实现登录页",
        objective: "用户能用邮箱登录",
        acceptance: "e2e 通过",
        artifacts: ["page:abc", " ", "/docs/api.md"],
      }),
    ).toBe("请实现登录页\n目标：用户能用邮箱登录\n验收标准：e2e 通过\n引用：page:abc，/docs/api.md");
    expect(formatHandoffBrief({ message: " 看下 ", context: "  " })).toBe("看下");
  });

  it("explains a failed handoff and uses the chain notice for the hop limit", () => {
    expect(failedHandoffNotice("团队-前端", "hop_limit")).toBe(HANDOFF_CHAIN_LIMIT_NOTICE);
    expect(failedHandoffNotice("团队-前端", "hand_back")).toBe(
      "未能交接给 团队-前端：不能直接交回给刚交来的成员。",
    );
  });
});
