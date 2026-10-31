import { describe, expect, it } from "vitest";
import { bareCompletionClaim } from "./group-stage-output.js";

describe("bareCompletionClaim", () => {
  it("flags a short done-claim with nothing to show", () => {
    for (const text of [
      "初稿完成",
      "已完成。",
      "写完了，交给主编",
      "Done.",
      "接口已经实现了",
      "",
    ]) {
      expect(bareCompletionClaim(text), text).toBe(true);
    }
  });

  it("accepts a reply that carries or points at its output", () => {
    for (const text of [
      "完成，见 src/Login.tsx",
      "已完成：https://example.test/doc",
      "写好了：\n- 标题：A\n- 正文：B",
      "完成了 `POST /login`",
      "```ts\nexport const a = 1;\n```\n完成",
    ]) {
      expect(bareCompletionClaim(text), text).toBe(false);
    }
  });

  it("leaves long or non-claim replies alone", () => {
    expect(bareCompletionClaim(`完成。${"正文内容".repeat(50)}`)).toBe(false);
    expect(bareCompletionClaim("目标读者是谁？")).toBe(false);
    expect(bareCompletionClaim("稿 1")).toBe(false);
  });
});
