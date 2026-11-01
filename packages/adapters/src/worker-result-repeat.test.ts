import { describe, expect, it } from "vitest";
import {
  INCOMPLETE_LAST_SIGNATURE_KEY,
  nearlyIdenticalSignatures,
  resultSignature,
  storedResultSignature,
} from "./worker-result-repeat.js";

const REPORT = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 条：内容已核对。`).join("\n");

describe("resultSignature / nearlyIdenticalSignatures", () => {
  it("treats an identical repeat as a repeat", () => {
    expect(nearlyIdenticalSignatures(resultSignature(REPORT), resultSignature(REPORT))).toBe(true);
  });

  it("ignores whitespace and case differences", () => {
    const spaced = REPORT.replace(/\n/g, "\n\n  ").toUpperCase();
    expect(nearlyIdenticalSignatures(resultSignature(REPORT), resultSignature(spaced))).toBe(true);
  });

  it("treats one changed sentence in twenty as nearly identical", () => {
    const edited = REPORT.replace("第 3 条：内容已核对。", "第 3 条：内容已更新。");
    expect(nearlyIdenticalSignatures(resultSignature(REPORT), resultSignature(edited))).toBe(true);
  });

  it("does not treat a substantially new reply as a repeat", () => {
    const next = `${REPORT}\n${Array.from({ length: 5 }, (_, i) => `新增 ${i}。`).join("\n")}`;
    expect(nearlyIdenticalSignatures(resultSignature(REPORT), resultSignature(next))).toBe(false);
    expect(
      nearlyIdenticalSignatures(resultSignature("还没做完。"), resultSignature("做完了。")),
    ).toBe(false);
  });

  it("never matches an empty signature", () => {
    expect(nearlyIdenticalSignatures([], resultSignature(REPORT))).toBe(false);
    expect(nearlyIdenticalSignatures(resultSignature(REPORT), [])).toBe(false);
  });

  it("reads the stored signature defensively", () => {
    expect(storedResultSignature(undefined)).toEqual([]);
    expect(storedResultSignature({ [INCOMPLETE_LAST_SIGNATURE_KEY]: ["a", 1, "b"] })).toEqual([
      "a",
      "b",
    ]);
  });
});
