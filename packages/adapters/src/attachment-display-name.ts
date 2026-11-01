import path from "node:path";

/**
 * The name an attached file is shown and downloaded under. A caller (often the model's attach_file
 * `name`) may give a friendlier title, but the file's own extension is kept: "L1 数据分析报告" for
 * report_L1.md downloads as "L1 数据分析报告.md", so it opens, previews and gets its type icon.
 */
export function attachmentDisplayName(
  requested: string | undefined,
  fileName: string,
  maxLength: number,
): string {
  const title = requested?.trim();
  const extension = path.extname(fileName);
  if (!title) return fileName.slice(0, maxLength);
  if (!extension || title.toLowerCase().endsWith(extension.toLowerCase())) {
    return title.slice(0, maxLength);
  }
  return `${title.slice(0, Math.max(1, maxLength - extension.length))}${extension}`;
}
