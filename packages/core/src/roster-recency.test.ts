import { describe, expect, it } from "vitest";
import { groupBotsForSidebar } from "./bot-sections.js";
import { rosterRecency, sortByRosterRecency } from "./roster-recency.js";

const chat = (id: string, updatedAt: string | null, status = "idle", pinned = false) => ({
  id,
  updatedAt,
  status,
  pinned,
  sectionId: null,
});

describe("sortByRosterRecency", () => {
  it("puts working chats first, then the newest reply, keeping ties in server order", () => {
    const chats = [
      chat("old", "2026-10-20T08:00:00.000Z"),
      chat("tie-a", "2026-10-25T08:00:00.000Z"),
      chat("busy-old", "2026-10-01T08:00:00.000Z", "running"),
      chat("tie-b", "2026-10-25T08:00:00.000Z"),
      chat("new", "2026-10-26T08:00:00.000Z"),
      chat("busy-new", "2026-10-02T08:00:00.000Z", "queued"),
      chat("never", null),
    ];
    expect(sortByRosterRecency(chats, (item) => item).map((item) => item.id)).toEqual([
      "busy-new",
      "busy-old",
      "new",
      "tie-a",
      "tie-b",
      "old",
      "never",
    ]);
    expect(chats[0]!.id).toBe("old");
  });

  it("does not boost a chat that is only waiting on the user", () => {
    expect(rosterRecency(chat("ask", "2026-10-26T08:00:00.000Z", "waiting_input"))).toBe(
      Date.parse("2026-10-26T08:00:00.000Z"),
    );
    expect(rosterRecency(chat("bad", "not a date"))).toBe(0);
  });

  it("orders each sidebar list by recency while pinned chats keep their hand order", () => {
    const bots = [
      chat("pin-old", "2026-10-01T08:00:00.000Z", "idle", true),
      chat("pin-new", "2026-10-26T08:00:00.000Z", "idle", true),
      chat("chief", "2026-10-20T08:00:00.000Z"),
      { ...chat("sec-old", "2026-10-02T08:00:00.000Z"), sectionId: "work" },
      chat("replied", "2026-10-26T08:00:00.000Z"),
      { ...chat("sec-busy", "2026-10-01T08:00:00.000Z", "running"), sectionId: "work" },
    ];
    const groups = groupBotsForSidebar(bots, [{ id: "work", name: "Work" }], {
      order: (items) => sortByRosterRecency(items, (item) => item),
    });
    expect(groups.map((group) => [group.key, group.bots.map((bot) => bot.id)])).toEqual([
      ["pinned", ["pin-old", "pin-new"]],
      ["section:work", ["sec-busy", "sec-old"]],
      ["unassigned", ["replied", "chief"]],
    ]);
  });
});
