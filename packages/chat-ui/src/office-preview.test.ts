import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { docxHtml, workbookMarkdown } from "./office-preview";

function workbook(sheets: Record<string, unknown[][]>): Uint8Array {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

describe("workbookMarkdown", () => {
  it("renders one sheet as a table of formatted values", () => {
    expect(
      workbookMarkdown(
        XLSX,
        workbook({
          S: [
            ["name", "n"],
            ["Ann", 3],
          ],
        }),
      ),
    ).toBe("| name | n |\n| --- | --- |\n| Ann | 3 |");
  });

  it("titles each sheet and reports rows beyond the preview", () => {
    const many = [["i"], ...Array.from({ length: 600 }, (_, i) => [i])];
    const out = workbookMarkdown(XLSX, workbook({ First: [["a"]], Big: many }));
    expect(out.startsWith("### First\n\n| a |")).toBe(true);
    expect(out).toContain("### Big");
    expect(out).toContain("_… 100 more rows_");
  });
});

describe("docxHtml", () => {
  it("wraps mammoth's HTML in a standalone page", async () => {
    const fake = { convertToHtml: async () => ({ value: "<p>Hello</p>" }) };
    const html = await docxHtml(fake, new Uint8Array([1, 2, 3]));
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("<body><p>Hello</p></body>");
  });

  it("rejects bytes that are not a docx", async () => {
    await expect(docxHtml(mammoth, new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
