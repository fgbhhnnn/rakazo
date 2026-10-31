import { describe, expect, it } from "vitest";
import { inferAttachmentMimeType } from "./attachments.js";

describe("source and config files as attachments", () => {
  it("attaches a worker's script as plain text, like its .md report", () => {
    expect(inferAttachmentMimeType("prime_sum_20000.py")).toBe("text/plain");
    expect(inferAttachmentMimeType("report TKEEB5F6.md")).toBe("text/markdown");
    expect(inferAttachmentMimeType("run.SH")).toBe("text/plain");
    expect(inferAttachmentMimeType("config.yaml")).toBe("text/plain");
  });

  it("keeps a supported reported type and still rejects unknown binaries", () => {
    expect(inferAttachmentMimeType("clip.ts", "video/mp2t")).toBe("text/plain");
    expect(inferAttachmentMimeType("data.json", "application/json")).toBe("application/json");
    expect(inferAttachmentMimeType("tool.exe")).toBeNull();
  });
});
