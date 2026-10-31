import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { STALE_NARRATION_MAX_CHARS, withoutStaleNarration } from "./group-stale-narration.js";

describe("withoutStaleNarration", () => {
  it("drops short narration and keeps other blocks", () => {
    const steps = { kind: "steps", steps: [] } as unknown as MessageBlock;
    expect(withoutStaleNarration([{ kind: "text", text: "已交给后端。" }, steps], "后端")).toEqual([
      steps,
    ]);
  });

  it("keeps a long reply with a note on when it was written", () => {
    const text = "x".repeat(STALE_NARRATION_MAX_CHARS + 1);
    expect(withoutStaleNarration([{ kind: "text", text }], "后端")).toEqual([
      { kind: "text", text: `（这段是交接前写的，后端 已在上方回复）\n${text}` },
    ]);
  });
});
