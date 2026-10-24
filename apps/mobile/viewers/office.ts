import { FILE_PREVIEW_MAX_COLUMNS, FILE_PREVIEW_MAX_ROWS } from "@rakazo/chat-ui/file-kinds";
import { docxHtml } from "@rakazo/chat-ui/office-preview";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { hostViewer } from "./host";

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Each sheet as an HTML table (first rows and columns only), with a tab strip for several sheets. */
function workbookHtml(bytes: Uint8Array): string {
  const book = XLSX.read(bytes, {
    type: "array",
    sheetRows: FILE_PREVIEW_MAX_ROWS + 1,
    cellHTML: false,
  });
  const sheets = book.SheetNames.map((name) => {
    const sheet = book.Sheets[name]!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });
    const range = sheet["!fullref"] ?? sheet["!ref"];
    const total = range ? XLSX.utils.decode_range(range).e.r + 1 : rows.length;
    const width = Math.min(FILE_PREVIEW_MAX_COLUMNS, Math.max(1, ...rows.map((row) => row.length)));
    const body = rows
      .map((row, index) => {
        const tag = index === 0 ? "th" : "td";
        return `<tr>${Array.from({ length: width }, (_, i) => `<${tag}>${escapeHtml(row[i])}</${tag}>`).join("")}</tr>`;
      })
      .join("");
    const more =
      total > rows.length ? `<p class="more">… ${total - rows.length} more rows</p>` : "";
    return { name, html: `<table>${body}</table>${more}` };
  }).filter((sheet) => sheet.html !== "<table></table>");
  if (sheets.length === 0) return `<p class="more">Empty workbook</p>`;
  return sheets
    .map((sheet) =>
      sheets.length > 1 ? `<h3>${escapeHtml(sheet.name)}</h3>${sheet.html}` : sheet.html,
    )
    .join("");
}

/** Mammoth's HTML, minus anything that could act: no scripts, handlers, frames or link targets. */
function inertDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const node of doc.querySelectorAll("script,iframe,object,embed,link,meta,form"))
    node.remove();
  for (const node of doc.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      const value = attribute.value.trim().toLowerCase();
      if (
        attribute.name.startsWith("on") ||
        attribute.name === "href" ||
        (attribute.name === "src" && !value.startsWith("data:image/"))
      )
        node.removeAttribute(attribute.name);
    }
  }
  return doc.body.innerHTML;
}

hostViewer(async (bytes, request, root) => {
  root.className = request.viewer;
  root.innerHTML =
    request.viewer === "docx" ? inertDocument(await docxHtml(mammoth, bytes)) : workbookHtml(bytes);
});
