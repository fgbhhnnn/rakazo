import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { backgroundTaskConcurrency } from "./background-tasks.js";
import { BUILTIN_AGENT_SKILLS, RAKAZO_DOCS_URLS } from "./builtin-skills.js";

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);
const publishedSlugs = [
  ...readFileSync(repoFile("apps/www/src/docs.ts"), "utf8").matchAll(/slug: "([\w-]+)"/g),
].map((match) => match[1]);

describe("Gose Bot skill", () => {
  it("links only to published docs pages", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "Gose Bot")!;
    const urls = [...skill.content.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
    expect(urls).toEqual(RAKAZO_DOCS_URLS);
    for (const url of urls) {
      const slug =
        url === "https://rakazo.com/docs.md"
          ? publishedSlugs[0]
          : /^https:\/\/rakazo\.com\/docs\/([\w-]+)\.md$/.exec(url)?.[1];
      expect(publishedSlugs, url).toContain(slug);
      expect(existsSync(repoFile(`docs/${slug}.md`)), url).toBe(true);
    }
  });
});

describe("built-in skills", () => {
  it("states the same parallel task limit as the dispatcher", () => {
    const text = JSON.stringify(BUILTIN_AGENT_SKILLS);
    const limit = backgroundTaskConcurrency({});
    expect(text).toContain(`最多同时 ${limit} 个`);
    expect(text).not.toMatch(/最多同时 (?!4 )\d+ 个/);
  });

  it("sends page-only reports to the think lane", () => {
    const text = BUILTIN_AGENT_SKILLS.map((skill) => skill.content).join("\n");
    expect(text).toContain('页面存在服务器上，不占电脑）的报告、方案也用 `lane: "think"`');
  });
});
