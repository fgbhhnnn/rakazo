import { OFFICE_ATTACHMENT_TYPES } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { readDroppedFiles as ReadDroppedFiles } from "./pick-attachments";

const state = vi.hoisted(() => ({ base64: vi.fn() }));

vi.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) {
      this.uri = uri;
    }
    info() {
      return { size: 1024 };
    }
    base64() {
      return state.base64();
    }
    text() {
      return Promise.resolve("");
    }
  },
  Paths: {},
}));
vi.mock("expo-document-picker", () => ({}));
vi.mock("expo-image-picker", () => ({}));
vi.mock("./file-drop", () => ({ releaseDroppedFile: async () => undefined }));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("./api", () => ({ rpc: vi.fn() }));

let readDroppedFiles: typeof ReadDroppedFiles;

beforeEach(async () => {
  vi.resetModules();
  state.base64.mockReset().mockResolvedValue("UEsDBA==");
  ({ readDroppedFiles } = await import("./pick-attachments"));
});

describe("Office files on mobile", () => {
  it.each(Object.entries(OFFICE_ATTACHMENT_TYPES))(
    "attaches a %s file the picker reports as octet-stream",
    async (extension, mimeType) => {
      const name = `报表${extension}`;
      const result = await readDroppedFiles([
        { uri: `file:///cache/${name}`, name, mimeType: "application/octet-stream", size: 1024 },
      ]);
      expect(result.skipped).toEqual([]);
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toMatchObject({ name, mimeType });
    },
  );

  it("labels Office artifacts by their extension", async () => {
    const { mimeBadgeLabel } = await import("./artifacts");
    expect(
      Object.values(OFFICE_ATTACHMENT_TYPES).map((mimeType) => mimeBadgeLabel(mimeType)),
    ).toEqual(["XLS", "XLSX", "DOC", "DOCX", "PPT", "PPTX"]);
  });
});
