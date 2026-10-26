import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DE_MESSAGES } from "./locales/de";
import { JA_MESSAGES } from "./locales/ja";
import { NL_MESSAGES } from "./locales/nl";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

describe("background coordinating line", () => {
  it("is localized everywhere and never carries a task count", () => {
    for (const messages of [DE_MESSAGES, JA_MESSAGES, NL_MESSAGES, RU_MESSAGES, ZH_MESSAGES]) {
      const label = messages["Coordinating background tasks"];
      expect(label).toBeTruthy();
      expect(label).not.toMatch(/\{count\}|\d/);
      expect(messages["Background tasks running ({count})"]).toBeUndefined();
    }
    expect(ZH_MESSAGES["Coordinating background tasks"]).toBe("正在协调后台任务");
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
