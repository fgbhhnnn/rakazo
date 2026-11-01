import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const {
  backgroundTaskConcurrency,
  backgroundTaskHash,
  buildBackgroundTaskMessage,
  taskAttachmentBlocks,
  workerDisabledTools,
  workerToolSurface,
} = await import("./background-tasks.js");
const { BACKGROUND_WORK_LAUNCH, CANCEL_COMPUTER_RUN_WORK } = await import("./computer-idle.js");

const names = ["shell", "read", "background_task", "spawn_bot", "web_search", "message_user"];

describe("background task helpers", () => {
  it("disables delegation tools and applies allowlists", () => {
    expect(workerDisabledTools(names, undefined)).toEqual([
      "background_task",
      "message_user",
      "spawn_bot",
    ]);
    expect(workerDisabledTools(names, ["read"])).toEqual(
      ["background_task", "message_user", "shell", "spawn_bot", "web_search"].sort(),
    );
  });

  it("reads the concurrency limit", () => {
    expect(backgroundTaskConcurrency({})).toBe(4);
    expect(backgroundTaskConcurrency({ RAKAZO_BACKGROUND_TASKS_PER_BOT: "5" })).toBe(5);
  });

  it("bounds the task message", () => {
    const text = buildBackgroundTaskMessage({
      name: "x",
      task: "y".repeat(50_000),
      agent: "general",
    });
    expect(text.length).toBeLessThanOrEqual(8000);
  });
});

describe("cancelBackgroundTask", () => {
  it("really kills a worker's running shell command (CANCEL_COMPUTER_RUN_WORK)", async () => {
    const computerId = `c-${randomUUID()}`;
    const runId = `r-${randomUUID()}`;
    const child = spawn(
      "bash",
      [
        "-c",
        BACKGROUND_WORK_LAUNCH,
        "rakazo-background-launch",
        computerId,
        runId,
        randomUUID(),
        "sleep 60",
      ],
      { stdio: "ignore" },
    );
    const exited = new Promise<number>((resolve) =>
      child.on("exit", () => resolve(performance.now())),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(child.exitCode).toBeNull();
    const started = performance.now();
    await new Promise<void>((resolve) =>
      spawn("bash", ["-c", CANCEL_COMPUTER_RUN_WORK, "rakazo-cancel-run-work", computerId, runId], {
        stdio: "ignore",
      }).on("exit", () => resolve()),
    );
    const exitedAt = await exited;
    const ms = exitedAt - started;
    // biome-ignore lint/suspicious/noConsole: report observed cancel latency
    console.info(`[cancel latency] real shell kill: ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(5000);
  });
});

describe("taskAttachmentBlocks", () => {
  it("keeps file and image blocks once, in order", () => {
    const file = { kind: "file", artifactId: "a1", name: "a.csv" };
    const image = { kind: "image", artifactId: "a2", name: "b.png" };
    const text = { kind: "text", text: "hi" };
    const out = taskAttachmentBlocks([text, file, image, file] as never);
    expect(out.map((b) => b.artifactId)).toEqual(["a1", "a2"]);
  });
});

describe("backgroundTaskHash", () => {
  it("matches a repeat of the same task, not same-name different work", () => {
    const a = backgroundTaskHash({ name: "sum", agent: "general", task: "Sum  column B\n" });
    expect(backgroundTaskHash({ name: "Sum", agent: "general", task: "sum column b" })).toBe(a);
    expect(backgroundTaskHash({ name: "sum", agent: "general", task: "sum column c" })).not.toBe(a);
    expect(backgroundTaskHash({ name: "other", agent: "general", task: "sum column b" })).not.toBe(
      a,
    );
    expect(backgroundTaskHash({ name: "sum", agent: "research", task: "sum column b" })).not.toBe(
      a,
    );
  });
});

describe("worker tool surface", () => {
  it("never exposes user- or bot-facing messaging or delegation to a worker", () => {
    const all = [
      "shell",
      "read",
      "web_search",
      "ask_user",
      "message_user",
      "message_bot",
      "message_agent",
      "background_task",
      "spawn_bot",
    ];
    const exposed = workerToolSurface(all, undefined);
    expect(exposed).toEqual(["shell", "read", "web_search"]);
    expect(workerToolSurface(all, ["read", "ask_user"])).toEqual(["read"]);
  });
});
