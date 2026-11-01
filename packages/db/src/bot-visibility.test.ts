import { describe, expect, it } from "vitest";
import { HIDDEN_BOT_SPAWN_PREFIX, isHiddenBot, VISIBLE_BOT_WHERE } from "./bot-visibility.js";

describe("bot visibility", () => {
  it("hides background workers by spawnKey, keeps every other bot", () => {
    expect(isHiddenBot({ spawnKey: `${HIDDEN_BOT_SPAWN_PREFIX}b1:1` })).toBe(true);
    expect(isHiddenBot({ spawnKey: null })).toBe(false);
    expect(isHiddenBot({ spawnKey: "research-helper" })).toBe(false);
    expect(isHiddenBot({})).toBe(false);
  });

  it("keeps NULL spawnKey bots in the where clause", () => {
    expect(VISIBLE_BOT_WHERE).toEqual({
      OR: [{ spawnKey: null }, { NOT: { spawnKey: { startsWith: "bg-worker:" } } }],
    });
  });
});
