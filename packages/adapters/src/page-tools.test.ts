import { BUILTIN_TOOL_NAMES } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKGROUND_AGENT_PROFILES, WORKER_INSTRUCTIONS } from "./background-tasks.js";
import { builtinAgentTools } from "./builtin-tools.js";
import { DISPATCHER_TOOL_NAMES } from "./dispatcher-mode.js";
import { PAGE_TOOL_NAMES, runPageTool } from "./page-tools.js";
import { createPage, PageError, readPage, updatePage } from "./pages.js";

vi.mock("./pages.js", async (original) => {
  const actual = await original<typeof import("./pages.js")>();
  return { ...actual, createPage: vi.fn(), readPage: vi.fn(), updatePage: vi.fn() };
});

const deps = {} as Parameters<typeof runPageTool>[0];
const scope = {
  spaceId: "space",
  userId: "user",
  botId: "owner-bot",
  groupId: null,
  runId: "run",
  operationId: "op",
  secrets: ["sk-secret-value"],
};
const page = {
  id: "page-1",
  artifactId: "art-2",
  botId: "owner-bot",
  groupId: null,
  title: "Plan",
  snippet: "s",
  version: 2,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  markdown: "## Goals\nold line\n",
};
const block = {
  kind: "file" as const,
  artifactId: "art-2",
  mimeType: "text/markdown",
  name: "Plan",
  size: 3,
  page: { pageId: "page-1" },
};

beforeEach(() => vi.clearAllMocks());

describe("page tools", () => {
  it("are built-in tools workers get and the dispatcher does not", () => {
    for (const name of PAGE_TOOL_NAMES) {
      expect(BUILTIN_TOOL_NAMES).toContain(name);
      expect(builtinAgentTools.map((tool) => tool.name)).toContain(name);
      expect(DISPATCHER_TOOL_NAMES.has(name)).toBe(false);
      for (const profile of ["researcher", "coder", "media"] as const)
        expect(BACKGROUND_AGENT_PROFILES[profile].tools).toContain(name);
    }
    expect(WORKER_INSTRUCTIONS).toContain("write_page");
    expect(WORKER_INSTRUCTIONS).toContain("不要再写 report.md");
  });

  it("writes a page for the owner bot with secrets masked and returns its card", async () => {
    vi.mocked(createPage).mockResolvedValue({
      page: { ...page, version: 1 },
      block,
      created: true,
    });
    const outcome = await runPageTool(deps, scope, "write_page", {
      title: "Plan",
      markdown: "key sk-secret-value here",
    });
    expect(createPage).toHaveBeenCalledWith(deps, {
      spaceId: "space",
      userId: "user",
      botId: "owner-bot",
      groupId: null,
      runId: "run",
      title: "Plan",
      markdown: expect.not.stringContaining("sk-secret-value"),
      operationId: "op",
    });
    expect(outcome).toEqual({
      result: { ok: true, page_id: "page-1", title: "Plan", version: 1, shown_to_user: true },
      block,
    });
  });

  it("applies find/replace edits against the version it read", async () => {
    vi.mocked(readPage).mockResolvedValue(page);
    vi.mocked(updatePage).mockResolvedValue({
      page: { ...page, version: 3 },
      block,
      created: false,
    });
    const outcome = await runPageTool(deps, scope, "edit_page", {
      page_id: "page-1",
      edits: [{ find: "old line", replace: "new line" }],
    });
    expect(readPage).toHaveBeenCalledWith(deps, {
      spaceId: "space",
      userId: "user",
      botIds: ["owner-bot"],
      pageId: "page-1",
    });
    expect(updatePage).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({
        pageId: "page-1",
        markdown: "## Goals\nnew line\n",
        baseVersion: 2,
        botIds: ["owner-bot"],
        runId: "run",
      }),
    );
    expect(outcome.result).toMatchObject({ ok: true, version: 3 });
    expect(outcome.block).toBe(block);
  });

  it("replaces the whole body without a version check", async () => {
    vi.mocked(updatePage).mockResolvedValue({ page, block, created: false });
    await runPageTool(deps, scope, "edit_page", { page_id: "page-1", markdown: "# New" });
    expect(readPage).not.toHaveBeenCalled();
    expect(updatePage).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ markdown: "# New", baseVersion: undefined }),
    );
  });

  it("explains bad arguments without writing", async () => {
    expect((await runPageTool(deps, scope, "edit_page", {})).result).toEqual({
      error: "page_id is required",
    });
    expect(
      (await runPageTool(deps, scope, "edit_page", { page_id: "p", markdown: "x", edits: [] }))
        .result,
    ).toEqual({ error: "pass edits or markdown, not both" });
    expect(
      (await runPageTool(deps, scope, "edit_page", { page_id: "p", edits: [{ find: 1 }] })).result,
    ).toEqual({ error: "each edit needs find and replace strings" });
    vi.mocked(readPage).mockResolvedValue(page);
    expect(
      (
        await runPageTool(deps, scope, "edit_page", {
          page_id: "page-1",
          edits: [{ find: "missing", replace: "x" }],
        })
      ).result,
    ).toEqual({ error: "edit 1: find text not found", page_id: "page-1" });
    expect(updatePage).not.toHaveBeenCalled();
  });

  it("reads the current markdown and turns page errors into tool errors", async () => {
    vi.mocked(readPage).mockResolvedValueOnce(page);
    expect((await runPageTool(deps, scope, "read_page", { page_id: "page-1" })).result).toEqual({
      page_id: "page-1",
      title: "Plan",
      version: 2,
      updated_at: page.updatedAt,
      markdown: page.markdown,
    });
    vi.mocked(readPage).mockRejectedValueOnce(new PageError("NOT_FOUND", "page not found"));
    expect((await runPageTool(deps, scope, "read_page", { page_id: "x" })).result).toEqual({
      error: "page not found",
    });
  });
});
