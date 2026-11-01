import { describe, expect, it } from "vitest";
import { ATTACHMENT_FILE_MIME_TYPES, isAllowedAttachmentMimeType } from "./attachments.js";
import {
  isOfficeAssociationMislabel,
  isOfficeAttachmentMimeType,
  OFFICE_ATTACHMENT_MIME_TYPES,
  OFFICE_ATTACHMENT_TYPES,
  OFFICE_MIME_TYPE_EXTENSIONS,
} from "./office-attachments.js";

describe("Office attachment types", () => {
  it.each(Object.entries(OFFICE_ATTACHMENT_TYPES))("allows %s as %s", (extension, mimeType) => {
    expect(isAllowedAttachmentMimeType(mimeType)).toBe(true);
    expect((ATTACHMENT_FILE_MIME_TYPES as readonly string[]).includes(mimeType)).toBe(true);
    expect(OFFICE_MIME_TYPE_EXTENSIONS[mimeType]).toBe(extension);
  });

  it("covers exactly the six Office formats with their registered MIME types", () => {
    expect(OFFICE_ATTACHMENT_TYPES).toEqual({
      ".xls": "application/vnd.ms-excel",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".doc": "application/msword",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".ppt": "application/vnd.ms-powerpoint",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    });
    expect(OFFICE_ATTACHMENT_MIME_TYPES).toHaveLength(6);
  });

  it("does not treat other types as Office", () => {
    expect(isOfficeAttachmentMimeType("application/pdf")).toBe(false);
    expect(isOfficeAttachmentMimeType(undefined)).toBe(false);
    expect(isAllowedAttachmentMimeType("application/vnd.ms-excel.sheet.macroEnabled.12")).toBe(
      false,
    );
  });

  it("flags an Office type the OS reported for a non-Office extension", () => {
    expect(isOfficeAssociationMislabel("text/csv", "application/vnd.ms-excel")).toBe(true);
    expect(
      isOfficeAssociationMislabel("application/vnd.ms-excel", "application/vnd.ms-excel"),
    ).toBe(false);
    expect(isOfficeAssociationMislabel(undefined, "application/vnd.ms-excel")).toBe(false);
    expect(isOfficeAssociationMislabel("text/csv", "text/csv")).toBe(false);
  });
});
