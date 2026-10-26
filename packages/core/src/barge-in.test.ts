import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInterimBargeIn,
  INTERIM_BARGE_IN_MS,
  isCallBargeIn,
  isInterimCallBargeIn,
} from "./barge-in.js";
import { spokenMemory } from "./echo.js";

const SPOKEN = "I'm here and hearing you";

describe("call barge-in", () => {
  afterEach(() => {
    spokenMemory.clear();
  });

  it.each(["stop", "Stop!", "WAIT", "hold on", "Hold on.", "pause", "no"])(
    "lets the interruption %j cut a reply short",
    (text) => {
      expect(isCallBargeIn(text)).toBe(true);
    },
  );

  it("lets a sentence cut a reply short", () => {
    expect(isCallBargeIn("wait, what about the deploy")).toBe(true);
    expect(isInterimCallBargeIn("what about the deploy")).toBe(true);
  });

  it("keeps playing through a one-word backchannel", () => {
    expect(isCallBargeIn("yeah")).toBe(false);
    expect(isInterimCallBargeIn("yeah")).toBe(false);
    expect(isInterimCallBargeIn("stop")).toBe(false);
  });

  it("ignores the reply leaking back at the playback threshold", () => {
    spokenMemory.remember(SPOKEN);
    expect(isCallBargeIn("I am here what about that")).toBe(false);
    expect(isInterimCallBargeIn("I am here and hearing")).toBe(false);
  });

  it("ignores an empty transcript", () => {
    expect(isCallBargeIn("   ")).toBe(false);
    expect(isInterimCallBargeIn("")).toBe(false);
  });
});

describe("CJK call barge-in", () => {
  afterEach(() => {
    spokenMemory.clear();
  });
  it("does not cut playback on the reply's own Chinese echo", () => {
    spokenMemory.remember("好的，我来帮你查一下。今天天气不错。");
    expect(isInterimCallBargeIn("好的，我来")).toBe(false);
    expect(isCallBargeIn("好的，我来帮你查一下")).toBe(false);
  });
  it("lets a real Chinese sentence or a stop word interrupt", () => {
    spokenMemory.remember("好的，我来帮你查查天气。");
    expect(isInterimCallBargeIn("帮我看看明天的会议")).toBe(true);
    expect(isCallBargeIn("等一下")).toBe(true);
    expect(isInterimCallBargeIn("嗯嗯")).toBe(false);
  });
  it("keeps treating a long reply's echo as echo once the transcript grows past the cap", () => {
    const reply =
      "好的，我已经帮你查过了，明天上海多云，最高气温二十三度，最低十六度。出门记得带件外套，晚上可能会有点凉。还有别的需要吗？";
    spokenMemory.remember(reply);
    const heard =
      "好的我已经帮你查过了明天上海多云最高气温二十三度最低十六度出门记得带件外套晚上可能会有点凉";
    expect(isInterimCallBargeIn(heard)).toBe(false);
    expect(isCallBargeIn(heard)).toBe(false);
    expect(isInterimCallBargeIn(`${heard}帮我订一张去北京的机票`)).toBe(true);
  });
});

describe("interim barge-in countdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("cuts in once a phrase stands long enough, and only once", () => {
    vi.useFakeTimers();
    const onBargeIn = vi.fn();
    const interim = createInterimBargeIn(onBargeIn);
    interim.hear("what about");
    vi.advanceTimersByTime(INTERIM_BARGE_IN_MS - 1);
    // A revision that still qualifies keeps the running countdown.
    interim.hear("what about the deploy");
    expect(onBargeIn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onBargeIn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INTERIM_BARGE_IN_MS);
    expect(onBargeIn).toHaveBeenCalledTimes(1);
  });

  it("resets when the phrase stops qualifying or is cleared", () => {
    vi.useFakeTimers();
    const onBargeIn = vi.fn();
    const interim = createInterimBargeIn(onBargeIn);
    interim.hear("what about");
    interim.hear("yeah");
    vi.advanceTimersByTime(INTERIM_BARGE_IN_MS);
    interim.hear("what about");
    interim.clear();
    vi.advanceTimersByTime(INTERIM_BARGE_IN_MS);
    expect(onBargeIn).not.toHaveBeenCalled();
  });
});
