import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { messageRowLayout } from "./message-row-layout";

const markdown = {
  kind: "file",
  artifactId: "notes",
  name: `gallery/${"attachment-notes-".repeat(12)}.md`,
  mimeType: "text/markdown",
  size: 1024,
} satisfies MessageBlock;
const csv: MessageBlock = {
  kind: "file",
  artifactId: "table",
  name: "gallery/table.csv",
  mimeType: "text/csv",
  size: 2048,
};
const image: MessageBlock = {
  kind: "image",
  artifactId: "preview",
  name: "preview.png",
  mimeType: "image/png",
};

describe("attachment message widths", () => {
  it.each([
    { name: "group bot", activityBotId: "bot-1", inGroup: true, gutter: 28 },
    { name: "direct bot", activityBotId: "bot-1", inGroup: false, gutter: 36 },
    { name: "group user", activityBotId: undefined, inGroup: true, gutter: 0 },
    { name: "direct user", activityBotId: undefined, inGroup: false, gutter: 0 },
  ])("gives $name attachments a definite width within the message column", (context) => {
    for (const columnWidth of [320, 393, 600]) {
      for (const files of [[markdown], [csv], [markdown, csv], [image, markdown], [image]]) {
        for (const caption of [
          [],
          [{ kind: "text", text: markdown.name } satisfies MessageBlock],
        ]) {
          const layout = messageRowLayout([...caption, ...files], { ...context, columnWidth });
          const available = columnWidth - 40 - context.gutter;
          expect(layout.menuFullWidth).toBe(true);
          expect(layout.menuMaxWidth).toBe(context.activityBotId ? available : available * 0.9);
          expect(layout.menuMaxWidth).toBeGreaterThan(220);
          expect(layout.menuMaxWidth).toBeLessThanOrEqual(available);
          expect(layout.width).toBe(context.activityBotId ? undefined : "90%");
        }
      }
    }
  });

  it("keeps text-only messages sized by their content", () => {
    for (const activityBotId of [undefined, "bot-1"]) {
      const layout = messageRowLayout([{ kind: "text", text: "Hello" }], {
        activityBotId,
        inGroup: true,
        columnWidth: 393,
      });
      expect(layout.menuFullWidth).toBe(false);
      expect(layout.width).toBeUndefined();
    }
  });
});
