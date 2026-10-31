import { describe, expect, it } from "vitest";
import { alreadySentThisTurn } from "./background-tasks.js";

describe("alreadySentThisTurn", () => {
  it("sends a note to a worker once per turn, even reworded", () => {
    expect(alreadySentThisTurn("run-1", "w1", "名单只收官网自己公开的商务邮箱，个人邮箱不要")).toBe(
      false,
    );
    expect(
      alreadySentThisTurn("run-1", "w1", "名单只收官网自己公开的商务邮箱，个人邮箱都不要"),
    ).toBe(true);
    expect(alreadySentThisTurn("run-1", "w2", "名单只收官网自己公开的商务邮箱，个人邮箱不要")).toBe(
      false,
    );
    expect(alreadySentThisTurn("run-2", "w1", "名单只收官网自己公开的商务邮箱，个人邮箱不要")).toBe(
      false,
    );
    expect(alreadySentThisTurn("run-1", "w1", "另外把表格改成按国家排序")).toBe(false);
  });
});
