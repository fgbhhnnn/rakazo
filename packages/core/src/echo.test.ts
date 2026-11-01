import { describe, expect, it } from "vitest";
import { isEchoOfSpeech, SpokenMemory } from "./echo.js";

const SPOKEN = "I'm here and hearing you…";

describe("isEchoOfSpeech", () => {
  it("catches a fragment of the reply that just played", () => {
    expect(isEchoOfSpeech("I am here in", SPOKEN)).toBe(true);
  });

  it("catches a fragment with filler around it", () => {
    expect(isEchoOfSpeech("hey I am here and here", SPOKEN)).toBe(true);
  });

  it("keeps a genuine short turn", () => {
    expect(isEchoOfSpeech("what should we do next", SPOKEN)).toBe(false);
  });

  it("keeps a long turn that happens to share words", () => {
    expect(
      isEchoOfSpeech(
        "I am not sure you are hearing me so let me say the whole thing again from the top",
        SPOKEN,
      ),
    ).toBe(false);
  });

  it("drops a looser overlap only at the playback threshold", () => {
    expect(isEchoOfSpeech("I am here what about that", SPOKEN)).toBe(false);
    expect(isEchoOfSpeech("I am here what about that", SPOKEN, 0.4)).toBe(true);
  });

  it("keeps everything when nothing was spoken", () => {
    expect(isEchoOfSpeech("I am here in", "")).toBe(false);
  });

  const NEWSPAPER = "Happy to, but I'm not sure which newspaper you mean";

  it("catches a 2-word echo that leads the spoken line", () => {
    expect(isEchoOfSpeech("happy to", NEWSPAPER)).toBe(true);
  });

  it("catches a 2-word echo adjacent mid-line", () => {
    expect(isEchoOfSpeech("tell me", "…just tell me the client…")).toBe(true);
  });

  it("catches a 2-word echo further in the line", () => {
    expect(isEchoOfSpeech("new project", "…tell me which new project you meant…")).toBe(true);
  });

  it("drops a 2-word pair that isn't adjacent in the line", () => {
    expect(isEchoOfSpeech("hello there", NEWSPAPER)).toBe(false);
  });

  it("keeps a single word, never an echo", () => {
    expect(isEchoOfSpeech("yes", NEWSPAPER)).toBe(false);
  });

  it("drops a 2-word pair that only appears non-adjacently", () => {
    expect(isEchoOfSpeech("happy sure", NEWSPAPER)).toBe(false);
  });
});

describe("SpokenMemory", () => {
  it("catches an echo of a reply the bot has already spoken past", () => {
    const memory = new SpokenMemory();
    memory.remember(SPOKEN, 0);
    memory.remember("Booked for Friday", 1_000);

    expect(memory.isEcho("hey I am here and here", undefined, 2_000)).toBe(true);
  });

  it("catches a line the mic heard across two spoken sentences", () => {
    const memory = new SpokenMemory();
    memory.remember("Okay, give me a second", 0);
    memory.remember("I am checking the deploy now", 500);

    expect(memory.isEcho("a second I am checking", undefined, 1_000)).toBe(true);
  });

  it("forgets what was spoken more than the window ago", () => {
    const memory = new SpokenMemory();
    memory.remember(SPOKEN, 0);

    expect(memory.isEcho("hey I am here and here", undefined, 14_000)).toBe(true);
    expect(memory.isEcho("hey I am here and here", undefined, 16_000)).toBe(false);
  });

  it("keeps a genuine turn, and everything once cleared", () => {
    const memory = new SpokenMemory();
    memory.remember(SPOKEN, 0);

    expect(memory.isEcho("what should we do next", undefined, 100)).toBe(false);
    memory.clear();
    expect(memory.isEcho("hey I am here and here", undefined, 100)).toBe(false);
  });
});

describe("CJK echo", () => {
  const zh = "好的，我来帮你查一下。今天天气不错。我们继续下一步。";
  it.each(["好的我来帮你查一下", "好的，我来", "好的 我来帮你 查一下", "今天天气不错"])(
    "treats %j as the reply leaking back",
    (heard) => {
      expect(isEchoOfSpeech(heard, zh, 0.4)).toBe(true);
      expect(isEchoOfSpeech(heard, zh)).toBe(true);
    },
  );
  it("keeps a genuine Chinese turn", () => {
    expect(isEchoOfSpeech("帮我看看明天的会议安排", zh, 0.4)).toBe(false);
  });
});
