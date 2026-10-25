import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  BACKGROUND_LANE_GUIDANCE,
  backgroundTaskConcurrency,
  effectiveLane,
  isThinkWorker,
  laneComputer,
  laneDisabledTools,
  laneHeads,
  laneLimit,
  laneOfTask,
  laneQueueOrder,
  laneSlots,
  requestedLane,
  slotLane,
  THINK_LANE_WITHHELD_TOOLS,
  THINK_SLOT_BASE,
  THINK_WORKER_COMPUTER_REFUSAL,
  thinkTaskConcurrency,
  thinkWorkerToolRefusal,
  withholdComputerToolsFromThinkWorker,
  workerSlotOfSpawnKey,
} from "./background-task-lanes.js";
import { backgroundWorkerSpawnKey } from "./background-tasks.js";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { applyDispatcherToolPolicy, BACKGROUND_DISPATCH_GUIDANCE } from "./dispatcher-mode.js";
import { workerDisabledTools, workerToolSurface } from "./worker-tool-policy.js";

const think = (id: string) => ({ id, args: { lane: "think" } });
const computer = (id: string) => ({ id, args: { agent: "general" } });
const legacy = (id: string) => ({ id, args: null });

describe("background task lanes: limits", () => {
  it("keeps the computer lane's env and default, and gives the think lane 20", () => {
    expect(backgroundTaskConcurrency({})).toBe(4);
    expect(backgroundTaskConcurrency({ RAKAZO_BACKGROUND_TASKS_PER_BOT: "6" })).toBe(6);
    expect(backgroundTaskConcurrency({ RAKAZO_BACKGROUND_TASKS_PER_BOT: "99" })).toBe(10);
    expect(backgroundTaskConcurrency({ RAKAZO_BACKGROUND_TASKS_PER_BOT: "0" })).toBe(4);
    expect(thinkTaskConcurrency({})).toBe(20);
    expect(thinkTaskConcurrency({ RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "7" })).toBe(7);
    expect(thinkTaskConcurrency({ RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "50" })).toBe(20);
    expect(thinkTaskConcurrency({ RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "0" })).toBe(0);
    expect(thinkTaskConcurrency({ RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "abc" })).toBe(20);
    expect(thinkTaskConcurrency({ RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "-1" })).toBe(20);
    // The two limits are independent.
    const env = {
      RAKAZO_BACKGROUND_TASKS_PER_BOT: "2",
      RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "3",
    };
    expect(laneLimit("computer", env)).toBe(2);
    expect(laneLimit("think", env)).toBe(3);
  });

  it("gives each lane its own slot range, so a slot's lane follows from its number", () => {
    const env = {
      RAKAZO_BACKGROUND_TASKS_PER_BOT: "10",
      RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "20",
    };
    const computerSlots = laneSlots("computer", env);
    const thinkSlots = laneSlots("think", env);
    expect(computerSlots).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(thinkSlots[0]).toBe(THINK_SLOT_BASE + 1);
    expect(thinkSlots.at(-1)).toBe(THINK_SLOT_BASE + 20);
    expect(thinkSlots).toHaveLength(20);
    // Even at the computer lane's maximum the ranges never overlap.
    expect(Math.max(...computerSlots)).toBeLessThan(Math.min(...thinkSlots));
    for (const slot of computerSlots) expect(slotLane(slot)).toBe("computer");
    for (const slot of thinkSlots) expect(slotLane(slot)).toBe("think");
    expect(laneSlots("think", { RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "0" })).toEqual([]);
  });
});

describe("background task lanes: labels", () => {
  it("counts unlabelled and pre-lane rows as computer tasks", () => {
    expect(laneOfTask(legacy("a"))).toBe("computer");
    expect(laneOfTask({ args: {} })).toBe("computer");
    expect(laneOfTask({})).toBe("computer");
    expect(laneOfTask({ args: { lane: "computer" } })).toBe("computer");
    expect(laneOfTask({ args: { lane: "THINK" } })).toBe("computer");
    expect(laneOfTask(think("b"))).toBe("think");
  });

  it("defaults a background_task call to the computer lane and rejects unknown lanes", () => {
    expect(requestedLane(undefined, {})).toEqual({ lane: "computer" });
    expect(requestedLane("", {})).toEqual({ lane: "computer" });
    expect(requestedLane("computer", {})).toEqual({ lane: "computer" });
    expect(requestedLane(" Think ", {})).toEqual({ lane: "think" });
    expect(requestedLane("gpu", {})).toEqual({ error: 'lane must be "think" or "computer"' });
    expect(requestedLane(3, {})).toEqual({ error: 'lane must be "think" or "computer"' });
    // With the think lane turned off, think work runs in the computer lane.
    const off = { RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "0" };
    expect(requestedLane("think", off)).toEqual({ lane: "computer" });
    expect(effectiveLane(think("x"), off)).toBe("computer");
    expect(effectiveLane(think("x"), {})).toBe("think");
  });

  it("recognizes think workers by spawn key; existing workers stay computer workers", () => {
    expect(workerSlotOfSpawnKey(backgroundWorkerSpawnKey("bot1", 3))).toBe(3);
    expect(workerSlotOfSpawnKey(backgroundWorkerSpawnKey("bot1", 104))).toBe(104);
    expect(workerSlotOfSpawnKey("spawn:bot1:2")).toBeUndefined();
    expect(workerSlotOfSpawnKey(null)).toBeUndefined();
    expect(isThinkWorker({ spawnKey: backgroundWorkerSpawnKey("bot1", 1) })).toBe(false);
    expect(isThinkWorker({ spawnKey: backgroundWorkerSpawnKey("bot1", 10) })).toBe(false);
    expect(isThinkWorker({ spawnKey: backgroundWorkerSpawnKey("bot1", 101) })).toBe(true);
    expect(isThinkWorker({ spawnKey: backgroundWorkerSpawnKey("bot1", 120) })).toBe(true);
    expect(isThinkWorker({ spawnKey: null })).toBe(false);
    expect(isThinkWorker({ spawnKey: "user-spawn:101" })).toBe(false);
  });

  it("gives think workers no computer and computer workers the dispatcher's", () => {
    expect(laneComputer("think", "c1")).toEqual({ computerId: null });
    expect(laneComputer("think", null)).toEqual({ computerId: null });
    expect(laneComputer("computer", "c1")).toEqual({ computerId: "c1" });
    expect(laneComputer("computer", null)).toEqual({});
  });
});

describe("background task lanes: queueing", () => {
  it("keeps one FIFO queue per lane", () => {
    const queued = [computer("c1"), think("t1"), legacy("l1"), think("t2"), computer("c2")];
    const heads = laneHeads(queued, {});
    expect(heads.map((h) => [h.lane, h.head.id])).toEqual([
      ["computer", "c1"],
      ["think", "t1"],
    ]);
    const order = laneQueueOrder(queued, {});
    expect(Object.fromEntries(order)).toEqual({ c1: 1, t1: 1, l1: 2, t2: 2, c2: 3 });
  });

  it("still offers the think head when the computer queue is empty, and the other way round", () => {
    expect(laneHeads([think("t1"), think("t2")], {}).map((h) => [h.lane, h.head.id])).toEqual([
      ["think", "t1"],
    ]);
    expect(laneHeads([legacy("l1")], {}).map((h) => [h.lane, h.head.id])).toEqual([
      ["computer", "l1"],
    ]);
    expect(laneHeads([], {})).toEqual([]);
  });

  it("queues think tasks in the computer lane while the think lane is off", () => {
    const off = { RAKAZO_BACKGROUND_THINK_TASKS_PER_BOT: "0" };
    const queued = [think("t1"), computer("c1")];
    expect(laneHeads(queued, off).map((h) => [h.lane, h.head.id])).toEqual([["computer", "t1"]]);
    expect(Object.fromEntries(laneQueueOrder(queued, off))).toEqual({ t1: 1, c1: 2 });
  });
});

describe("background task lanes: think workers have no computer tools", () => {
  const thinkWorker = { spawnKey: backgroundWorkerSpawnKey("main", THINK_SLOT_BASE + 1) };
  const computerWorker = { spawnKey: backgroundWorkerSpawnKey("main", 1) };
  const computerToolNames = [
    "computer_observe",
    "computer_act",
    "browser_navigate",
    "browser_snapshot",
    "browser_act",
    "list_files",
    "read_file",
    "write_file",
    "attach_file",
    "shell",
    "open_path",
    "launch_app",
    "request_takeover",
    "render_plot",
  ];

  it("lists every builtin that runs on the computer", () => {
    for (const name of computerToolNames) expect(THINK_LANE_WITHHELD_TOOLS).toContain(name);
    for (const name of THINK_LANE_WITHHELD_TOOLS) expect(BUILTIN_TOOL_NAMES).toContain(name);
  });

  it("disables computer tools on a think task for every profile, and keeps thinking tools", () => {
    for (const allowlist of [undefined, ["shell", "web_search", "web_fetch"], ["read_file"]]) {
      const disabled = laneDisabledTools(
        "think",
        workerDisabledTools(BUILTIN_TOOL_NAMES, allowlist),
        BUILTIN_TOOL_NAMES,
      );
      for (const name of THINK_LANE_WITHHELD_TOOLS) expect(disabled).toContain(name);
      expect(disabled).toContain("background_task");
      expect(disabled).not.toContain("report_progress");
    }
    const general = laneDisabledTools(
      "think",
      workerDisabledTools(BUILTIN_TOOL_NAMES, undefined),
      BUILTIN_TOOL_NAMES,
    );
    // Pages are stored server-side, so think workers write their reports as pages.
    for (const name of [
      "web_search",
      "web_fetch",
      "recall_memory",
      "skill_read",
      "write_page",
      "edit_page",
      "read_page",
    ])
      expect(general).not.toContain(name);
    // A computer task's tool set is exactly what it was before lanes.
    const before = workerDisabledTools(BUILTIN_TOOL_NAMES, undefined);
    expect(laneDisabledTools("computer", before, BUILTIN_TOOL_NAMES)).toEqual(before);
    expect(before).not.toContain("shell");
  });

  it("withholds computer tools from a think worker's run surface, never from others", () => {
    const offered = builtinAgentTools.map((tool) => ({ name: tool.name }));
    const thinkDisabled = new Set<string>();
    applyDispatcherToolPolicy(true, thinkWorker, thinkDisabled, offered);
    const surface = offered.map((t) => t.name).filter((name) => !thinkDisabled.has(name));
    for (const name of THINK_LANE_WITHHELD_TOOLS) expect(surface).not.toContain(name);
    expect(surface).toContain("web_search");
    expect(surface).toContain("report_progress");
    expect(surface).toContain("write_page");
    // The nesting ban still holds in the think lane.
    expect(surface).not.toContain("background_task");
    expect(surface).not.toContain("run_subagent");

    const computerDisabled = new Set<string>();
    applyDispatcherToolPolicy(true, computerWorker, computerDisabled, offered);
    expect(computerDisabled.has("shell")).toBe(false);
    expect(computerDisabled.has("browser_act")).toBe(false);
    expect(computerDisabled.has("background_task")).toBe(true);

    const other = new Set<string>();
    withholdComputerToolsFromThinkWorker({ spawnKey: null }, other);
    expect(other.size).toBe(0);
  });

  it("refuses a computer tool a think worker calls anyway", () => {
    expect(thinkWorkerToolRefusal(thinkWorker, "shell")).toBe(THINK_WORKER_COMPUTER_REFUSAL);
    expect(thinkWorkerToolRefusal(thinkWorker, "browser_navigate")).toBe(
      THINK_WORKER_COMPUTER_REFUSAL,
    );
    expect(thinkWorkerToolRefusal(thinkWorker, "web_search")).toBeUndefined();
    expect(thinkWorkerToolRefusal(computerWorker, "shell")).toBeUndefined();
    expect(thinkWorkerToolRefusal({ spawnKey: null }, "shell")).toBeUndefined();
    expect(THINK_WORKER_COMPUTER_REFUSAL).toContain("需要电脑");
  });

  it("a general think task's surface keeps report_progress and no computer tool", () => {
    const disabled = laneDisabledTools(
      "think",
      workerDisabledTools(BUILTIN_TOOL_NAMES, undefined),
      BUILTIN_TOOL_NAMES,
    );
    const surface = workerToolSurface(BUILTIN_TOOL_NAMES, undefined).filter(
      (name) => !disabled.includes(name),
    );
    expect(surface).toContain("report_progress");
    for (const name of THINK_LANE_WITHHELD_TOOLS) expect(surface).not.toContain(name);
  });
});

describe("background task lanes: guidance", () => {
  it("tells the dispatcher how to pick a lane, defaulting to computer", () => {
    expect(BACKGROUND_DISPATCH_GUIDANCE.endsWith(BACKGROUND_LANE_GUIDANCE)).toBe(true);
    expect(BACKGROUND_LANE_GUIDANCE).toContain('When unsure, use "computer"');
    expect(BACKGROUND_LANE_GUIDANCE).toContain("需要电脑");
    expect(BACKGROUND_LANE_GUIDANCE).toContain("Queue positions are per lane");
  });

  it("offers the lane on the background_task tool", () => {
    const tool = builtinAgentTools.find((t) => t.name === "background_task");
    const schema = tool?.inputSchema as
      | { properties: Record<string, { enum?: string[] }> }
      | undefined;
    const lane = schema?.properties.lane;
    expect(lane?.enum).toEqual(["computer", "think"]);
    expect(tool?.description).toContain("think 20");
  });

  it("states both lane limits in the built-in skill", () => {
    const text = JSON.stringify(BUILTIN_AGENT_SKILLS);
    expect(text).toContain(`最多同时 ${backgroundTaskConcurrency({})} 个电脑任务`);
    expect(text).toContain(`上限 ${thinkTaskConcurrency({})} 个`);
  });
});

describe("computer-less turns", () => {
  it("use a placeholder computer whose scope the executor accepts", async () => {
    const { dispatcherComputerPlaceholder } = await import("./dispatcher-turn-guard.js");
    const { parseComputerMode } = await import("@rakazo/db");
    const placeholder = dispatcherComputerPlaceholder("bot-1") as { scope: string };
    expect(() => parseComputerMode(placeholder.scope)).not.toThrow();
  });
});
