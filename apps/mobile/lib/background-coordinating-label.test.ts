import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resetI18nForTests, t } from "./i18n";

afterEach(() => resetI18nForTests());

describe("background coordinating line", () => {
  it("is localized everywhere and never carries a task count", () => {
    for (const locale of ["de", "ja", "nl", "ru", "zh-CN"] as const) {
      resetI18nForTests(locale);
      const label = t("Coordinating background tasks");
      expect(label).toBeTruthy();
      expect(label).not.toBe("Coordinating background tasks");
      expect(label).not.toMatch(/\{count\}|\d/);
      expect(t("Background tasks running ({count})")).toBe("Background tasks running ({count})");
    }
    expect(t("Coordinating background tasks")).toBe("正在协调后台任务");
  });

  it("is what the chat's working row says while only background tasks run", () => {
    const screen = readFileSync(
      new URL("../components/thread/thread-screen.tsx", import.meta.url),
      "utf8",
    );
    expect(screen).toContain('t("Coordinating background tasks")');
    expect(screen).not.toContain("Background tasks running");
    const transcript = readFileSync(new URL("./thread-transcript.ts", import.meta.url), "utf8");
    expect(transcript).toContain("withoutBackgroundTaskCards(messages");
  });
});
