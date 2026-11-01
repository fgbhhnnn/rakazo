import { OFFICE_ATTACHMENT_TYPES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  attachmentExtensionForMimeType,
  inferAttachmentMimeType,
  messageBlockForArtifact,
  validateAttachmentMimeType,
} from "./attachments.js";

const cases = Object.entries(OFFICE_ATTACHMENT_TYPES);

describe("Office attachments", () => {
  it.each(cases)("infers %s from its name whatever the picker reported", (extension, mimeType) => {
    const name = `报表${extension}`;
    expect(inferAttachmentMimeType(name)).toBe(mimeType);
    expect(inferAttachmentMimeType(name.toUpperCase())).toBe(mimeType);
    expect(inferAttachmentMimeType(name, mimeType)).toBe(mimeType);
    expect(inferAttachmentMimeType(name, "application/octet-stream")).toBe(mimeType);
    expect(inferAttachmentMimeType(name, "")).toBe(mimeType);
  });

  it.each(cases)("validates %s and lands it on disk with its extension", (extension, mimeType) => {
    expect(() => validateAttachmentMimeType(mimeType)).not.toThrow();
    expect(attachmentExtensionForMimeType(mimeType)).toBe(extension);
    expect(
      messageBlockForArtifact({ id: "a1", name: `deck${extension}`, mimeType, size: 10 }),
    ).toEqual({ kind: "file", artifactId: "a1", mimeType, name: `deck${extension}`, size: 10 });
  });

  it("keeps a CSV a CSV when Windows reports it as an Excel file", () => {
    expect(inferAttachmentMimeType("data.csv", "application/vnd.ms-excel")).toBe("text/csv");
    expect(inferAttachmentMimeType("notes.txt", "application/msword")).toBe("text/plain");
  });

  it("still rejects unknown types", () => {
    expect(inferAttachmentMimeType("macro.xlsm", "application/octet-stream")).toBeNull();
    expect(() => validateAttachmentMimeType("application/octet-stream")).toThrow();
  });
});
