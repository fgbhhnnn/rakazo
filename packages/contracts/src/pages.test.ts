import { describe, expect, it } from "vitest";
import { MessageBlock } from "./events.js";
import {
  applyPageEdits,
  pageContents,
  pageLayout,
  pageOutline,
  pagePath,
  pageSnippet,
  plainHeadingText,
  withoutRepeatedTitle,
} from "./pages.js";

const plan = [
  "Short intro.",
  "",
  "## Goals",
  "Ship **pages**.",
  "",
  "```md",
  "# not a heading",
  "```",
  "",
  "### Risks",
  "| a | b |",
  "|---|---|",
  "| 1 | 2 |",
  "",
  "## Goals",
  "Again.",
  "#### Deep detail",
  "x",
  "## 上线计划",
  "中文内容",
].join("\n");

describe("pageOutline", () => {
  it("splits at headings outside code fences with unique anchors", () => {
    const outline = pageOutline(plan);
    expect(outline.intro).toBe("Short intro.");
    expect(outline.sections.map((s) => [s.id, s.level, s.title])).toEqual([
      ["goals", 2, "Goals"],
      ["risks", 3, "Risks"],
      ["goals-2", 2, "Goals"],
      ["deep-detail", 4, "Deep detail"],
      ["上线计划", 2, "上线计划"],
    ]);
    expect(outline.sections[0]?.markdown).toContain("# not a heading");
    expect(outline.sections[1]?.markdown).toContain("| 1 | 2 |");
  });

  it("lists up to three heading levels as contents", () => {
    expect(pageContents(pageOutline(plan)).map((s) => s.id)).toEqual([
      "goals",
      "risks",
      "goals-2",
      "上线计划",
    ]);
  });

  it("keeps every line of the source across intro and sections", () => {
    const outline = pageOutline(plan);
    const joined = [outline.intro, ...outline.sections.map((s) => s.markdown)].join("\n");
    for (const line of plan.split("\n").filter(Boolean)) expect(joined).toContain(line);
  });

  it("names headings without words a section id", () => {
    expect(pageOutline("## 🚀\ntext").sections[0]?.id).toBe("section-1");
  });

  it("drops a first heading that repeats the title", () => {
    const outline = withoutRepeatedTitle(
      pageOutline("# Launch plan\nBody\n## Next\nmore"),
      "Launch plan",
    );
    expect(outline.intro).toBe("Body");
    expect(outline.sections.map((s) => s.title)).toEqual(["Next"]);
    const other = withoutRepeatedTitle(pageOutline("# Other\nBody"), "Launch plan");
    expect(other.sections).toHaveLength(1);
  });
});

describe("pageSnippet", () => {
  it("previews body text without headings, tables, code or marks", () => {
    expect(pageSnippet(plan)).toBe("Short intro. Ship pages. Again. x 中文内容");
  });

  it("caps long text on a character boundary", () => {
    const snippet = pageSnippet("长".repeat(400), 10);
    expect(Array.from(snippet)).toHaveLength(10);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("strips list marks and links", () => {
    expect(pageSnippet("- [x] done [docs](https://x.test)\n1. next")).toBe("done docs next");
  });
});

describe("applyPageEdits", () => {
  it("applies each edit once, in order", () => {
    expect(
      applyPageEdits("a b c", [
        { find: "b", replace: "B" },
        { find: "B c", replace: "done" },
      ]),
    ).toEqual({ ok: true, markdown: "a done" });
  });

  it("refuses missing, repeated and empty finds", () => {
    expect(applyPageEdits("a", [{ find: "z", replace: "" }])).toMatchObject({ ok: false });
    expect(applyPageEdits("a a", [{ find: "a", replace: "" }])).toMatchObject({
      ok: false,
      error: expect.stringContaining("more than once"),
    });
    expect(applyPageEdits("a", [{ find: "", replace: "x" }])).toMatchObject({ ok: false });
  });
});

describe("page blocks", () => {
  it("accepts a page file block and an older file block", () => {
    const base = {
      kind: "file",
      artifactId: "art_1",
      mimeType: "text/markdown",
      name: "Plan",
      size: 10,
    };
    expect(MessageBlock.parse({ ...base, page: { pageId: "art_1", snippet: "hi" } })).toEqual({
      ...base,
      page: { pageId: "art_1", snippet: "hi" },
    });
    expect(MessageBlock.parse(base)).toEqual(base);
  });

  it("links to the signed-in page route", () => {
    expect(pagePath("a b")).toBe("/app/pages/a%20b");
    expect(plainHeadingText("**Bold** `code` [link](x)")).toBe("Bold code link");
  });
});

describe("pageLayout", () => {
  it("drops a heading that repeats the title and indents contents from the top level", () => {
    const layout = pageLayout(
      "# Launch plan\n\nWhy now.\n\n## Goals\n\nShip.\n\n### Risks\n\nTime.\n\n## Timeline\n\nQ4.",
      "Launch plan",
    );
    expect(layout.intro).toBe("Why now.");
    expect(layout.contents.map((section) => [section.title, section.depth])).toEqual([
      ["Goals", 0],
      ["Risks", 1],
      ["Timeline", 0],
    ]);
    expect(layout.sections.map((section) => section.title)).toEqual(["Goals", "Risks", "Timeline"]);
  });

  it("keeps a page without headings as one intro with no contents", () => {
    const layout = pageLayout("Just a short memo.", "Memo");
    expect(layout).toEqual({ intro: "Just a short memo.", sections: [], contents: [] });
  });
});
