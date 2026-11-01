import { IsolationError } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { assertOpenableBot } from "./hidden-worker-access.js";

describe("assertOpenableBot", () => {
  it("refuses a hidden background worker like a missing bot", () => {
    expect(() => assertOpenableBot({ spawnKey: "bg-worker:main:1" })).toThrow(IsolationError);
  });

  it("passes every listed bot through", () => {
    const bot = { id: "b", spawnKey: "first-bot" };
    expect(assertOpenableBot(bot)).toBe(bot);
    expect(assertOpenableBot({ spawnKey: null })).toEqual({ spawnKey: null });
  });
});
