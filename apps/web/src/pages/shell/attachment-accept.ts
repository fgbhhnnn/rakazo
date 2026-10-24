import { ATTACHMENT_ALLOWED_MIME_TYPES, OFFICE_ATTACHMENT_TYPES } from "@rakazo/contracts";

/**
 * The composer file picker's accept list: every allowed MIME type, plus extensions for types
 * whose reported MIME varies by OS (zip, and Office documents, which some systems report as
 * application/octet-stream).
 */
export const ATTACHMENT_ACCEPT = [
  ...ATTACHMENT_ALLOWED_MIME_TYPES,
  ".zip",
  ...Object.keys(OFFICE_ATTACHMENT_TYPES),
].join(",");
