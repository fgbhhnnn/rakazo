import { describe, expect, it } from "vitest";
import { AccountExportRecordSchema } from "./account-export.js";
import { MessageBlock } from "./events.js";
import { appContract } from "./index.js";
import {
  applyPageEdits,
  PAGE_SOURCE_MAX_BYTES,
  PAGE_TITLE_MAX_LENGTH,
  PageSourceSchema,
  PageSummarySchema,
  PageTitleSchema,
  pageContents,
  pageLayout,
  pageOutline,
  pagePath,
  pageSnippet,
  plainHeadingText,
  SharedPageSchema,
  withoutRepeatedTitle,
} from "./pages.js";

describe("PageTitleSchema", () => {
  it("folds line breaks and control characters into single spaces", () => {
    expect(PageTitleSchema.parse("  Q3\nplan\r\n\tdraft\u0000 \u2028end ")).toBe(
      "Q3 plan draft end",
    );
  });

  it("refuses titles that are empty or too long once folded", () => {
    expect(PageTitleSchema.safeParse("\n\t\u0007").success).toBe(false);
    expect(PageTitleSchema.safeParse("x".repeat(PAGE_TITLE_MAX_LENGTH)).success).toBe(true);
    expect(PageTitleSchema.safeParse("x".repeat(PAGE_TITLE_MAX_LENGTH + 1)).success).toBe(false);
  });
});

it("bounds the titles pages send out by the cap a saved title has", () => {
  const at = "2026-11-02T10:00:00.000Z";
  const summary = (title: string) =>
    PageSummarySchema.safeParse({
      id: "page-1",
      title,
      botId: null,
      groupId: null,
      visibility: "private",
      currentVersion: 1,
      pinned: false,
      createdAt: at,
      updatedAt: at,
    }).success;
  const shared = (title: string) =>
    SharedPageSchema.safeParse({ title, code: "", version: 1, updatedAt: at }).success;
  const longest = "x".repeat(PAGE_TITLE_MAX_LENGTH);
  expect([summary(longest), shared(longest)]).toEqual([true, true]);
  expect([summary(`${longest}x`), shared(`${longest}x`)]).toEqual([false, false]);
});

describe("PageSourceSchema", () => {
  it("measures source in UTF-8 bytes, as the save check does", () => {
    expect(PageSourceSchema.safeParse("x".repeat(PAGE_SOURCE_MAX_BYTES)).success).toBe(true);
    expect(PageSourceSchema.safeParse("x".repeat(PAGE_SOURCE_MAX_BYTES + 1)).success).toBe(false);
    // Fewer characters than the limit, more bytes.
    expect(PageSourceSchema.safeParse("é".repeat(PAGE_SOURCE_MAX_BYTES / 2)).success).toBe(true);
    expect(PageSourceSchema.safeParse(`${"é".repeat(PAGE_SOURCE_MAX_BYTES / 2)}x`).success).toBe(
      false,
    );
  });
});

it("lets a newer client's reply from a page reach an older server, which drops what it does not know", () => {
  const send = appContract.threads.send["~orpc"].inputSchema!;
  // An older server's thread send is this object without fromPage: an unknown key is dropped, not refused.
  expect(send.parse({ botId: "bot-1", text: "hi", fromPage: true, notYetKnown: true })).toEqual({
    botId: "bot-1",
    text: "hi",
    fromPage: true,
  });
});

it("refuses an exported page version past the database's 32-bit column", () => {
  const record = (version: number) => ({
    type: "page_version",
    id: "src-page-v1",
    pageId: "src-page",
    version,
    title: "Plan",
    source: "export default () => null;",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  expect(AccountExportRecordSchema.safeParse(record(2_147_483_647)).success).toBe(true);
  expect(AccountExportRecordSchema.safeParse(record(2_147_483_648)).success).toBe(false);
});

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
