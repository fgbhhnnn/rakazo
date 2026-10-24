import { describe, expect, it } from "vitest";
import { backgroundTaskConcurrency } from "./background-tasks.js";
import { BUILTIN_AGENT_SKILLS } from "./builtin-skills.js";

describe("built-in skills", () => {
  it("states the same parallel task limit as the dispatcher", () => {
    const text = JSON.stringify(BUILTIN_AGENT_SKILLS);
    const limit = backgroundTaskConcurrency({});
    expect(text).toContain(`最多同时 ${limit} 个`);
    expect(text).not.toMatch(/最多同时 (?!4 )\d+ 个/);
  });
});
