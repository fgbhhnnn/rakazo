import type { MessageBlock } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { dispatcherTaskAttachments } from "./task-attachments.js";

const file = (artifactId: string, name: string): MessageBlock => ({
  kind: "file",
  artifactId,
  name,
  mimeType: "text/csv",
  size: 10,
});

describe("dispatcherTaskAttachments", () => {
  const oldUpload = file("a-old", "up TK3C7DFF.csv");
  const otherOld = file("a-other", "up_TKAB2306.csv");

  it("does not hand earlier uploads to an unrelated task", () => {
    expect(
      dispatcherTaskAttachments({
        turn: [[{ kind: "text", text: "echo hi" }]],
        recent: [oldUpload, otherOld],
        taskText: "echo TK29A0F1",
      }),
    ).toEqual([]);
  });

  it("always carries the files of the messages that led to the dispatch", () => {
    const now = file("a-now", "report.csv");
    const steer = file("a-steer", "extra.csv");
    expect(
      dispatcherTaskAttachments({
        turn: [[now], [steer, now]],
        recent: [oldUpload],
        taskText: "sum column B",
      }).map((b) => (b as { artifactId: string }).artifactId),
    ).toEqual(["a-now", "a-steer"]);
  });

  it("carries an earlier upload the task names, with or without its extension", () => {
    expect(
      dispatcherTaskAttachments({
        turn: [],
        recent: [oldUpload, otherOld],
        taskText: "读取 up TK3C7DFF.csv 的 B 列求和",
      }).map((b) => (b as { artifactId: string }).artifactId),
    ).toEqual(["a-old"]);
    expect(
      dispatcherTaskAttachments({
        turn: [],
        recent: [oldUpload, otherOld],
        taskText: "use up_tkab2306 again",
      }).map((b) => (b as { artifactId: string }).artifactId),
    ).toEqual(["a-other"]);
  });

  it("does not match a short stem inside ordinary words", () => {
    expect(
      dispatcherTaskAttachments({
        turn: [],
        recent: [file("a-data", "data.csv")],
        taskText: "summarize the data trends",
      }),
    ).toEqual([]);
  });
});
