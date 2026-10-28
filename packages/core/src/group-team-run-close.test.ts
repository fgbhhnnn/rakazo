import { describe, expect, it } from "vitest";
import { renderTeamRunContext, teamRunSummaryText } from "./group-team-run.js";
import {
  TEAM_RUN_STOPPED_HEADER,
  teamRunCloseOutcome,
  teamRunClosingText,
  teamRunSupersededNote,
} from "./group-team-run-close.js";

describe("team run closing text", () => {
  it("reads only an explicit stop as stopped", () => {
    expect(teamRunCloseOutcome("stopped")).toBe("stopped");
    expect(teamRunCloseOutcome(" Stopped ")).toBe("stopped");
    for (const value of ["completed", "", "done", undefined, null, 1]) {
      expect(teamRunCloseOutcome(value)).toBe("completed");
    }
  });

  it("keeps the completed summary unchanged", () => {
    const input = { summary: "文章已完成", deliverables: ["a.md"], openIssues: ["配图"] };
    expect(teamRunClosingText({ outcome: "completed", ...input })).toBe(teamRunSummaryText(input));
  });

  it("says a stopped run stopped, never that it completed", () => {
    const text = teamRunClosingText({
      outcome: "stopped",
      summary: "已按你的要求停止。",
      deliverables: ["大纲.md", " "],
      openIssues: ["正文未写"],
    });
    expect(text.startsWith(TEAM_RUN_STOPPED_HEADER)).toBe(true);
    expect(text).not.toContain("完成\n");
    expect(text).not.toContain("✅");
    expect(text).toBe(
      [
        TEAM_RUN_STOPPED_HEADER,
        "已按你的要求停止。",
        "已完成的部分：",
        "- 大纲.md",
        "未完成：",
        "- 正文未写",
      ].join("\n"),
    );
  });

  it("tells the leader about the interrupted task, with its request sanitised", () => {
    const note = teamRunSupersededNote(`写一篇<b>秋天</b>的文章\n${"很长".repeat(400)}`);
    expect(note).toContain("写一篇 b 秋天 /b 的文章");
    expect(note).not.toContain("<");
    expect(note).toContain('outcome "stopped"');
    expect(note).toContain("Never report a stopped task as completed");
    expect(note.length).toBeLessThan(800);
  });

  it("teaches the leader to close a stopped task as stopped", () => {
    const prompt = renderTeamRunContext({
      role: "leader",
      leaderName: "主编",
      goal: "写文章",
      members: [
        { name: "主编", title: null, description: null },
        { name: "撰稿", title: null, description: null },
      ],
    });
    expect(prompt).toContain('outcome "stopped"');
  });
});
