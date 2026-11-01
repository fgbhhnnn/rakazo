import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { dispatcherImageNote, dispatcherWithholdsImages } from "./dispatcher-image-context.js";

const image = (artifactId: string, name: string): MessageBlock =>
  ({ kind: "image", artifactId, name, mimeType: "image/png", size: 10 }) as MessageBlock;

describe("dispatcher image context", () => {
  it("withholds image bytes only from a dispatcher's main turn", () => {
    expect(dispatcherWithholdsImages(true)).toBe(true);
    expect(dispatcherWithholdsImages(false)).toBe(false);
  });

  it("names this message's images and says the worker gets them", () => {
    const note = dispatcherImageNote([
      { kind: "text", text: "what's wrong here" } as MessageBlock,
      image("a1", "IMG_1.png"),
      image("a2", "IMG_2.png"),
      image("a2", "IMG_2.png"),
    ]);
    expect(note).toContain('The user attached 2 images to this message: "IMG_1.png", "IMG_2.png".');
    expect(note).toContain("do not describe or guess");
    expect(note).toContain("background_task");
  });

  it("uses the singular for one image", () => {
    expect(dispatcherImageNote([image("a1", "shot.jpg")])).toContain(
      'attached 1 image to this message: "shot.jpg"',
    );
  });

  it("lists earlier images separately and says to name them in the task", () => {
    const note = dispatcherImageNote(
      [image("a1", "now.png")],
      ["before.png", "now.png", "before.png"],
    );
    expect(note).toContain(
      'Images attached earlier in this conversation (not visible to you): "before.png".',
    );
    expect(note).toContain("name the file in the background_task text");
  });

  it("says nothing when there are no images", () => {
    expect(dispatcherImageNote(undefined)).toBe("");
    expect(dispatcherImageNote([{ kind: "text", text: "hi" } as MessageBlock])).toBe("");
  });
});
