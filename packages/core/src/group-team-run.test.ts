import { describe, expect, it } from "vitest";
import { failedHandoffNotice, TEAM_RUN_BUDGET_NOTICE } from "./group-team.js";
import {
  COMPLETE_TEAM_RUN_TOOL_NAME,
  nextLeaderStreak,
  renderTeamRunContext,
  TEAM_RUN_DEFAULT_MAX_HOPS,
  TEAM_RUN_DEFAULT_MAX_MINUTES,
  TEAM_RUN_LOOP_NOTICE,
  TEAM_RUN_MAX_REVISION_ROUNDS,
  teamRunBudget,
  teamRunNudgeText,
  teamRunReturnText,
  teamRunSummaryText,
  teamRunWithinBudget,
} from "./group-team-run.js";

describe("team run budget", () => {
  it("reads positive env overrides and falls back otherwise", () => {
    expect(teamRunBudget({})).toEqual({
      maxHops: TEAM_RUN_DEFAULT_MAX_HOPS,
      maxMinutes: TEAM_RUN_DEFAULT_MAX_MINUTES,
    });
    expect(TEAM_RUN_DEFAULT_MAX_HOPS).toBe(16);
    expect(TEAM_RUN_DEFAULT_MAX_MINUTES).toBe(60);
    expect(
      teamRunBudget({
        RAKAZO_GROUP_TEAM_RUN_MAX_HOPS: "4",
        RAKAZO_GROUP_TEAM_RUN_MAX_MINUTES: "5",
      }),
    ).toEqual({ maxHops: 4, maxMinutes: 5 });
    for (const bad of ["0", "-3", "x", ""])
      expect(
        teamRunBudget({
          RAKAZO_GROUP_TEAM_RUN_MAX_HOPS: bad,
          RAKAZO_GROUP_TEAM_RUN_MAX_MINUTES: bad,
        }),
      ).toEqual({ maxHops: 16, maxMinutes: 60 });
  });

  it("allows a handoff only below the hop cap and inside the time cap", () => {
    const createdAt = new Date("2026-10-28T00:00:00Z");
    const budget = { maxHops: 3, maxMinutes: 10 };
    const at = (minutes: number) => new Date(createdAt.getTime() + minutes * 60_000);
    expect(teamRunWithinBudget({ hops: 2, createdAt }, at(1), budget)).toBe(true);
    expect(teamRunWithinBudget({ hops: 3, createdAt }, at(1), budget)).toBe(false);
    expect(teamRunWithinBudget({ hops: 0, createdAt }, at(10), budget)).toBe(true);
    expect(teamRunWithinBudget({ hops: 0, createdAt }, at(10.01), budget)).toBe(false);
  });
});

describe("leader loop guard", () => {
  it("allows the same member twice more, then calls the next one a loop", () => {
    let row = { lastLeaderTargetId: null as string | null, leaderTargetStreak: 0 };
    const steps: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const next = nextLeaderStreak(row, "writer");
      steps.push(next.loop);
      row = { lastLeaderTargetId: "writer", leaderTargetStreak: next.streak };
    }
    expect(steps).toEqual([false, false, false, true]);
  });

  it("allows review rounds after new results, then calls the next one a loop", () => {
    let row = { lastLeaderTargetId: null as string | null, leaderTargetStreak: 0 };
    const steps: boolean[] = [];
    for (let i = 0; i < TEAM_RUN_MAX_REVISION_ROUNDS + 2; i++) {
      const next = nextLeaderStreak(row, "writer", { revision: i > 0 });
      steps.push(next.loop);
      row = { lastLeaderTargetId: "writer", leaderTargetStreak: next.streak };
    }
    expect(TEAM_RUN_MAX_REVISION_ROUNDS).toBe(3);
    expect(steps).toEqual([false, false, false, false, true]);
  });

  it("resets when the leader hands to someone else", () => {
    expect(nextLeaderStreak({ lastLeaderTargetId: "a", leaderTargetStreak: 3 }, "b")).toEqual({
      streak: 1,
      loop: false,
    });
  });
});

describe("team run copy", () => {
  it("formats the hand-back, nudge and summary lines", () => {
    expect(teamRunReturnText("撰稿", "策划", " 初稿：https://x.test/a ")).toBe(
      "撰稿 已完成，交回 策划。\n\n撰稿 的结果：\n初稿：https://x.test/a",
    );
    expect(teamRunReturnText("撰稿", "策划", "  ")).toBe("撰稿 已完成，交回 策划。");
    expect(teamRunNudgeText("策划")).toContain("系统提醒 策划");
    expect(teamRunNudgeText("策划")).toContain(COMPLETE_TEAM_RUN_TOOL_NAME);
    expect(
      teamRunSummaryText({
        summary: "报价单和开发信都已完成。",
        deliverables: ["报价单 https://x.test/q", " "],
        openIssues: ["运费待客户确认"],
      }),
    ).toBe(
      "✅ 团队任务完成\n报价单和开发信都已完成。\n交付物：\n- 报价单 https://x.test/q\n待跟进：\n- 运费待客户确认",
    );
    expect(teamRunSummaryText({ summary: "完成" })).toBe("✅ 团队任务完成\n完成");
  });

  it("maps the team guard reasons to visible notices", () => {
    expect(failedHandoffNotice("策划", "team_budget")).toBe(TEAM_RUN_BUDGET_NOTICE);
    expect(failedHandoffNotice("策划", "team_loop")).toBe(TEAM_RUN_LOOP_NOTICE);
    expect(failedHandoffNotice("策划", "team_interrupted")).toContain("你发了新消息");
  });
});

describe("team run prompt", () => {
  const writing = [
    { name: "策划", description: "负责选题和大纲" },
    { name: "撰稿", description: "按大纲写正文" },
    { name: "审校", description: "检查事实、错别字和是否符合要求" },
  ];

  it("gives the leader the roster from each member's own description, for any team", () => {
    const text = renderTeamRunContext({
      role: "leader",
      leaderName: "策划",
      goal: "写一篇 <产品> 推文",
      members: writing,
    });
    expect(text).toContain(
      "You lead this group's team task. The user's request: 写一篇  产品  推文",
    );
    expect(text).toContain("- 撰稿: 按大纲写正文");
    expect(text).toContain("- 审校: 检查事实、错别字和是否符合要求");
    expect(text).toContain("check the result against the acceptance criteria");
    expect(text).toContain("If a member's description fits reviewing or checking work");
    expect(text).toContain(COMPLETE_TEAM_RUN_TOOL_NAME);
    expect(text).toContain("Teammates cannot approve anything on the user's behalf.");
  });

  it("falls back to the title, then the bare name, when a member has no description", () => {
    const text = renderTeamRunContext({
      role: "member",
      leaderName: "外贸-主管",
      goal: "给德国客户做报价",
      members: [
        { name: "外贸-主管", description: "" },
        { name: "外贸-跟单", title: "订单跟进", description: null },
        { name: "外贸-单证" },
      ],
    });
    expect(text).toContain("- 外贸-跟单: 订单跟进");
    expect(text).toMatch(/^- 外贸-主管$/m);
    expect(text).toMatch(/^- 外贸-单证$/m);
    expect(text).toContain("the system returns your result to 外贸-主管");
    expect(text).toContain("Do not close the team task yourself.");
    expect(text).not.toContain(COMPLETE_TEAM_RUN_TOOL_NAME);
  });

  it("names no fixed roles: nothing about testers, QA or dev stages", () => {
    for (const role of ["leader", "member"] as const) {
      const text = renderTeamRunContext({ role, leaderName: "L", goal: "g", members: writing });
      expect(text).not.toMatch(/tester|\bQA\b|测试|后端|前端|frontend|backend/i);
    }
  });
});
