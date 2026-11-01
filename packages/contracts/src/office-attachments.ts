/**
 * Microsoft Office documents users can attach (spreadsheets, Word documents, slide decks). They
 * are stored and handed to the bot's computer as ordinary files, where Python (openpyxl,
 * python-docx, python-pptx, pandas) or LibreOffice can read and convert them.
 */
export const OFFICE_ATTACHMENT_TYPES = {
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const;

export type OfficeAttachmentMimeType =
  (typeof OFFICE_ATTACHMENT_TYPES)[keyof typeof OFFICE_ATTACHMENT_TYPES];

export const OFFICE_ATTACHMENT_MIME_TYPES: readonly OfficeAttachmentMimeType[] =
  Object.values(OFFICE_ATTACHMENT_TYPES);

/** Extension → MIME type, for inferring an Office file's type from its name. */
export const OFFICE_EXTENSION_MIME_TYPES: Readonly<Record<string, OfficeAttachmentMimeType>> =
  OFFICE_ATTACHMENT_TYPES;

/** MIME type → extension, for naming an Office file on disk. */
export const OFFICE_MIME_TYPE_EXTENSIONS = Object.fromEntries(
  Object.entries(OFFICE_ATTACHMENT_TYPES).map(([extension, mimeType]) => [mimeType, extension]),
) as Record<OfficeAttachmentMimeType, string>;

export function isOfficeAttachmentMimeType(
  mimeType: string | undefined,
): mimeType is OfficeAttachmentMimeType {
  return (OFFICE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType ?? "");
}

/**
 * Windows reports .csv as application/vnd.ms-excel (Excel owns the extension). A reported Office
 * type on a file whose name says something else is the OS's file association, not the content:
 * the caller should trust the extension.
 */
export function isOfficeAssociationMislabel(
  extensionType: string | undefined,
  reportedType: string | undefined,
): boolean {
  return (
    !!extensionType &&
    isOfficeAttachmentMimeType(reportedType) &&
    !isOfficeAttachmentMimeType(extensionType)
  );
}
