import { SandboxUnresponsiveError } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  ComputerDeadlineError,
  parseResourceProbe,
  RESOURCE_ALERT_PERCENT,
  RESOURCE_REALERT_MS,
  RESOURCE_REARM_PERCENT,
  RESTART_PROMPT_AFTER,
  resourceAlertDecision,
  resourceNoticeText,
  restartPromptContent,
  savedAgoText,
  withDeadline,
} from "./computer-health.js";

const now = new Date("2026-10-25T06:00:00.000Z");
const reading = (diskPercent: number | null, memoryPercent: number | null) => ({
  diskPercent,
  diskAvailableKiB: 2 * 1024 * 1024,
  memoryPercent,
});

describe("computer health", () => {
  it("parses the probe's disk and memory lines", () => {
    expect(parseResourceProbe("disk 91 1048576\nmem 8000000 400000\n")).toEqual({
      diskPercent: 91,
      diskAvailableKiB: 1048576,
      memoryPercent: 95,
    });
    expect(parseResourceProbe("disk 40 99\n")).toEqual({
      diskPercent: 40,
      diskAvailableKiB: 99,
      memoryPercent: null,
    });
    expect(parseResourceProbe("garbage\nmem 0 0\n")).toEqual({
      diskPercent: null,
      diskAvailableKiB: null,
      memoryPercent: null,
    });
  });

  it("announces a resource once when it crosses the threshold", () => {
    expect(RESOURCE_ALERT_PERCENT).toBe(90);
    const first = resourceAlertDecision(
      reading(92, 50),
      { alertedResources: null, alertedAt: null },
      now,
    );
    expect(first.announce).toEqual(["disk"]);
    expect([...first.alerted]).toEqual(["disk"]);

    const again = resourceAlertDecision(
      reading(95, 50),
      { alertedResources: "disk", alertedAt: new Date(now.getTime() - 60 * 60 * 1000) },
      now,
    );
    expect(again.announce).toEqual([]);
    expect([...again.alerted]).toEqual(["disk"]);
  });

  it("announces again for a newly full resource or after a day", () => {
    const recent = { alertedResources: "disk", alertedAt: new Date(now.getTime() - 60_000) };
    expect(resourceAlertDecision(reading(95, 93), recent, now).announce).toEqual([
      "disk",
      "memory",
    ]);
    const old = {
      alertedResources: "disk",
      alertedAt: new Date(now.getTime() - RESOURCE_REALERT_MS),
    };
    expect(resourceAlertDecision(reading(95, 10), old, now).announce).toEqual(["disk"]);
  });

  it("re-arms only once usage falls clearly below the threshold", () => {
    const alerted = { alertedResources: "disk", alertedAt: new Date(now.getTime() - 60_000) };
    const dip = resourceAlertDecision(reading(RESOURCE_REARM_PERCENT + 1, 10), alerted, now);
    expect([...dip.alerted]).toEqual(["disk"]);
    expect(dip.announce).toEqual([]);

    const low = resourceAlertDecision(reading(RESOURCE_REARM_PERCENT - 1, 10), alerted, now);
    expect([...low.alerted]).toEqual([]);
    const back = resourceAlertDecision(
      reading(91, 10),
      { alertedResources: null, alertedAt: alerted.alertedAt },
      now,
    );
    expect(back.announce).toEqual(["disk"]);
  });

  it("keeps what it knew about a resource the probe could not read", () => {
    const decision = resourceAlertDecision(
      reading(null, 20),
      { alertedResources: "disk", alertedAt: now },
      now,
    );
    expect([...decision.alerted]).toEqual(["disk"]);
    expect(decision.announce).toEqual([]);
  });

  it("writes the notice in plain words with the space left", () => {
    const text = resourceNoticeText(reading(93, 95), ["disk", "memory"]);
    expect(text).toContain("磁盘已用 93%");
    expect(text).toContain("只剩约 2.0 GB");
    expect(text).toContain("内存已用 95%");
    expect(resourceNoticeText(reading(93, 95), ["disk"])).not.toContain("内存");
  });

  it("asks before restarting and says what may be lost", () => {
    const content = restartPromptContent(new Date(now.getTime() - 3 * 60 * 60 * 1000), now);
    expect(content.text).toBe(`电脑连续 ${RESTART_PROMPT_AFTER} 次没有响应，要重启吗？`);
    expect(content.detail).toContain("上次保存的状态（约 3 小时前保存）");
    expect(content.detail).toContain("这之后的改动可能会丢失");
    expect(content.actions).toEqual([
      { id: "restart", label: "重启电脑" },
      { id: "keep", label: "先不重启" },
    ]);
    expect(savedAgoText(null, now)).toBe("上次保存的时间不详");
    expect(savedAgoText(new Date(now.getTime() - 5 * 60_000), now)).toBe("约 5 分钟前保存");
    expect(savedAgoText(new Date(now.getTime() - 3 * 24 * 3600_000), now)).toBe("约 3 天前保存");
  });

  it("aborts work past its deadline and reports the sandbox unresponsive", async () => {
    let signal: AbortSignal | undefined;
    const error = await withDeadline(
      20,
      (given) => {
        signal = given;
        return new Promise<never>(() => undefined);
      },
      () => new ComputerDeadlineError("checkpoint", 20),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxUnresponsiveError);
    expect(error).toBeInstanceOf(ComputerDeadlineError);
    expect(signal?.aborted).toBe(true);
    await expect(
      withDeadline(
        1000,
        async () => "done",
        () => new Error("late"),
      ),
    ).resolves.toBe("done");
    await expect(
      withDeadline(
        1000,
        async () => Promise.reject(new Error("own")),
        () => new Error("late"),
      ),
    ).rejects.toThrow("own");
  });
});
