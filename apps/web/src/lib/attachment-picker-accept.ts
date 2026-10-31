import { ATTACHMENT_ACCEPT } from "../pages/shell/attachment-accept";

/**
 * Android's document picker can filter out CSV files when the accept attribute
 * combines many MIME types. Allow the picker to show files on Android; the
 * attachment preparation and API still reject unsupported formats and sizes.
 * Elsewhere the composer's accept list (allowed MIME types, zip and Office extensions) plus .csv.
 */
export function attachmentPickerAccept(userAgent: string): string {
  if (/\bAndroid\b/i.test(userAgent)) return "*/*";
  return [ATTACHMENT_ACCEPT, ".csv"].join(",");
}
