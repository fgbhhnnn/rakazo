import { describe, expect, it } from "vitest";
import { attachmentDisplayName } from "./attachment-display-name.js";

describe("attachmentDisplayName", () => {
  it("keeps the file's extension on a friendlier title", () => {
    expect(attachmentDisplayName("L1 数据分析报告", "report_L1.md", 200)).toBe(
      "L1 数据分析报告.md",
    );
    expect(attachmentDisplayName("Q3 销售", "sales.XLSX", 200)).toBe("Q3 销售.XLSX");
  });

  it("does not double an extension the title already has", () => {
    expect(attachmentDisplayName("最终报告.md", "report.md", 200)).toBe("最终报告.md");
    expect(attachmentDisplayName("Final.PDF", "final.pdf", 200)).toBe("Final.PDF");
  });

  it("falls back to the file name and handles extensionless files", () => {
    expect(attachmentDisplayName(undefined, "report.md", 200)).toBe("report.md");
    expect(attachmentDisplayName("  ", "report.md", 200)).toBe("report.md");
    expect(attachmentDisplayName("构建脚本", "Makefile", 200)).toBe("构建脚本");
  });

  it("clamps the title, never the extension", () => {
    const name = attachmentDisplayName("报".repeat(50), "a.csv", 10);
    expect(name).toBe(`${"报".repeat(6)}.csv`);
    expect(name.length).toBe(10);
  });
});
