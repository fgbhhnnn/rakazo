import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { applyDispatcherToolPolicy } from "./dispatcher-mode.js";
import {
  WORKER_USER_FACING_REFUSAL,
  WORKER_USER_FACING_TOOLS,
  withholdUserFacingTools,
  workerUserFacingRefusal,
} from "./worker-user-facing-tools.js";

const worker = { spawnKey: "bg-worker:main:1", disabledBuiltinTools: ["background_task"] };
const child = { spawnKey: "main:helper", disabledBuiltinTools: [] };

describe("worker user-facing tools", () => {
  it("covers every card-posting and scheduling tool", () => {
    expect([...WORKER_USER_FACING_TOOLS].sort()).toEqual(
      [
        "add_mcp_server",
        "connect_agent",
        "connect_app",
        "forget_secret",
        "request_secret",
        "request_takeover",
        "respond_agent_connection",
        "schedule_cancel",
        "schedule_create",
        "schedule_list",
      ].sort(),
    );
  });

  it("withholds them from hidden workers only", () => {
    const disabled = new Set<string>();
    withholdUserFacingTools(worker, disabled);
    for (const name of WORKER_USER_FACING_TOOLS) expect(disabled.has(name)).toBe(true);
    // A worker still uses saved credentials through secret_request and list_secrets.
    expect(disabled.has("secret_request")).toBe(false);
    expect(disabled.has("list_secrets")).toBe(false);
    const childDisabled = new Set<string>();
    withholdUserFacingTools(child, childDisabled);
    withholdUserFacingTools({ spawnKey: null }, childDisabled);
    expect(childDisabled.size).toBe(0);
  });

  it("is applied by the dispatcher tool policy for workers in and out of dispatcher mode", () => {
    for (const mode of [true, false]) {
      const disabled = new Set<string>();
      applyDispatcherToolPolicy(mode, worker, disabled, [{ name: "schedule_create" }]);
      expect(disabled.has("schedule_create")).toBe(true);
      expect(disabled.has("request_secret")).toBe(true);
      expect(disabled.has("connect_app")).toBe(true);
    }
  });

  it("refuses a worker's call with a report-what-you-need message", () => {
    for (const name of WORKER_USER_FACING_TOOLS) {
      expect(workerUserFacingRefusal(worker, name)).toBe(WORKER_USER_FACING_REFUSAL);
      expect(workerUserFacingRefusal(child, name)).toBeUndefined();
    }
    expect(workerUserFacingRefusal(worker, "run_command")).toBeUndefined();
    expect(WORKER_USER_FACING_REFUSAL).toContain("report exactly what you need");
  });

  it("the Heavy Task skill no longer tells workers to schedule reminders", () => {
    const HEAVY_TASK_SKILL =
      BUILTIN_AGENT_SKILLS.find((skill) => skill.name === "Heavy Task Workflow")?.content ?? "";
    expect(HEAVY_TASK_SKILL).toContain("后台工作者没有 `schedule_create`");
    expect(HEAVY_TASK_SKILL).not.toContain("用 `schedule_create` 回来查状态");
    expect(HEAVY_TASK_SKILL).not.toContain("3. 用 `schedule_create` 设一个几分钟后的提醒");
  });
});
