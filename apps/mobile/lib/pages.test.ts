import { beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  currentApiBase: vi.fn(() => "https://server.example.test"),
}));
vi.mock("./api", () => api);

import {
  getPage,
  isPageConflict,
  listPages,
  pageCardFromBlock,
  pageRoute,
  pageShareLink,
  savePage,
  sectionScrollY,
} from "./pages";

beforeEach(() => {
  api.rpc.mockReset().mockResolvedValue([]);
});

it("calls the owner-only page procedures", async () => {
  await listPages({ botId: "bot-1", limit: 30 });
  await getPage("page-1");
  await savePage({ pageId: "page-1", markdown: "# Plan", baseVersion: 2 });
  expect(api.rpc.mock.calls).toEqual([
    ["pages/list", { botId: "bot-1", limit: 30 }],
    ["pages/get", { pageId: "page-1" }],
    ["pages/update", { pageId: "page-1", markdown: "# Plan", baseVersion: 2 }],
  ]);
});

it("shares the signed-in page link on the current server", () => {
  expect(pageShareLink("page-1")).toBe("https://server.example.test/app/pages/page-1");
  expect(pageShareLink("page-1", "http://192.168.1.4:8787/")).toBe(
    "http://192.168.1.4:8787/app/pages/page-1",
  );
});

it("opens the page route with the card title", () => {
  expect(pageRoute({ pageId: "page-1", title: "Plan" })).toEqual({
    pathname: "/page",
    params: { pageId: "page-1", title: "Plan" },
  });
});

it("reads only page file blocks as cards", () => {
  expect(
    pageCardFromBlock({
      kind: "file",
      name: "Plan",
      page: { pageId: "page-1", snippet: "Why now." },
    }),
  ).toEqual({ pageId: "page-1", title: "Plan", snippet: "Why now." });
  expect(pageCardFromBlock({ kind: "file", name: "report.md" })).toBeNull();
  expect(pageCardFromBlock({ kind: "image", name: "chart.png" })).toBeNull();
});

it("recognizes a save that lost to a newer version", () => {
  expect(isPageConflict(Object.assign(new Error("stale"), { code: "CONFLICT" }))).toBe(true);
  expect(isPageConflict(Object.assign(new Error("stale"), { status: 409 }))).toBe(true);
  expect(isPageConflict(new Error("offline"))).toBe(false);
  expect(isPageConflict(null)).toBe(false);
});

it("scrolls a section heading just under the top edge", () => {
  const offsets = new Map([
    ["goals", 0],
    ["timeline", 420],
  ]);
  expect(sectionScrollY(offsets, "timeline", 180)).toBe(588);
  expect(sectionScrollY(offsets, "goals", 6)).toBe(0);
  expect(sectionScrollY(offsets, "missing", 180)).toBeNull();
});
