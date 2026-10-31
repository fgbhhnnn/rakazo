import { FILE_PREVIEW_MAX_ROWS, rowsToMarkdownTable } from "./file-kinds";

/** The slice of SheetJS (`xlsx`) the preview uses; the caller loads the library lazily. */
export interface SheetJsLike {
  read(
    data: Uint8Array,
    options: { type: "array"; sheetRows?: number; cellHTML?: boolean; cellFormula?: boolean },
  ): { SheetNames: string[]; Sheets: Record<string, Record<string, unknown>> };
  utils: {
    sheet_to_json(
      sheet: Record<string, unknown>,
      options: { header: 1; raw: false; defval: string; blankrows: false },
    ): unknown[][];
    decode_range(range: string): { e: { r: number } };
  };
}

/** The slice of mammoth the preview uses. */
export interface MammothLike {
  convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
}

/** Every sheet of an xlsx/xls/ods workbook as a markdown table (first rows only). */
export function workbookMarkdown(xlsx: SheetJsLike, bytes: Uint8Array): string {
  const book = xlsx.read(bytes, {
    type: "array",
    sheetRows: FILE_PREVIEW_MAX_ROWS + 1,
    cellHTML: false,
    cellFormula: false,
  });
  const parts = book.SheetNames.flatMap((name) => {
    const sheet = book.Sheets[name];
    if (!sheet) return [];
    const rows = xlsx.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    if (rows.length === 0) return [];
    const range = (sheet["!fullref"] ?? sheet["!ref"]) as string | undefined;
    const total = range ? xlsx.utils.decode_range(range).e.r + 1 : rows.length;
    return [{ name, table: rowsToMarkdownTable(rows, Math.max(total, rows.length)) }];
  });
  if (parts.length === 0) return "_Empty workbook_";
  return parts
    .map((part) =>
      parts.length > 1 ? `### ${part.name.replace(/[#|\n]/g, " ")}\n\n${part.table}` : part.table,
    )
    .join("\n\n");
}

const DOCUMENT_STYLE =
  "body{font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:24px;color:#111;background:#fff;overflow-wrap:anywhere}" +
  "img{max-width:100%;height:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid #ccc;padding:4px 8px;vertical-align:top}";

/** A .docx as a standalone HTML page, for a sandboxed (script-free, offline) viewer. */
export async function docxHtml(mammoth: MammothLike, bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { value } = await mammoth.convertToHtml({ arrayBuffer: buffer as ArrayBuffer });
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${DOCUMENT_STYLE}</style></head><body>${value}</body></html>`;
}
