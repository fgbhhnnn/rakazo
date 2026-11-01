import { ATTACHMENT_ALLOWED_MIME_TYPES, OFFICE_ATTACHMENT_TYPES } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { ATTACHMENT_ACCEPT } from "./attachment-accept";

describe("composer accept list", () => {
  const accepted = ATTACHMENT_ACCEPT.split(",");

  it("offers Office documents by MIME type and by extension", () => {
    for (const [extension, mimeType] of Object.entries(OFFICE_ATTACHMENT_TYPES)) {
      expect(accepted).toContain(mimeType);
      expect(accepted).toContain(extension);
    }
  });

  it("keeps every allowed type and the zip extension", () => {
    for (const mimeType of ATTACHMENT_ALLOWED_MIME_TYPES) expect(accepted).toContain(mimeType);
    expect(accepted).toContain(".zip");
  });
});
