import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  capToolResultImages,
  DEFAULT_MAX_TOOL_IMAGES,
  imagePartCount,
  looksLikeContextOverflow,
  pruneForRebuild,
  toolImageLimit,
} from "./context-pruning.js";
import { withCappedImages } from "./pi-runtime.js";

const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
const toolImage = (id: string, path?: string): Message => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read_file",
  content: [{ type: "text", text: `page ${id}` }, image],
  ...(path ? { details: { path } } : {}),
  isError: false,
  timestamp: 1,
});
const userImage = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }, image],
  timestamp: 1,
});
const total = (messages: Message[]) => messages.reduce((n, m) => n + imagePartCount(m), 0);
const texts = (message: Message | undefined) =>
  Array.isArray(message?.content)
    ? (message.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? p.type)
    : [];

describe("tool image cap", () => {
  it("replaces the oldest tool images with a note and keeps user and newest images", () => {
    const messages = [
      userImage("look at this"),
      ...Array.from({ length: 12 }, (_, i) => toolImage(`t${i}`, `/work/page-${i}.png`)),
    ];
    const capped = capToolResultImages(messages, 8);
    expect(total(capped)).toBe(8);
    expect(imagePartCount(capped[0]!)).toBe(1);
    for (let i = 1; i <= 5; i++) {
      expect(imagePartCount(capped[i]!)).toBe(0);
      expect(texts(capped[i])).toEqual([
        `page t${i - 1}`,
        expect.stringContaining(
          `earlier image removed to save context: read_file /work/page-${i - 1}.png`,
        ),
      ]);
    }
    expect(imagePartCount(capped.at(-1)!)).toBe(1);
    // Inputs are not mutated.
    expect(total(messages)).toBe(13);
  });

  it("returns the same array when under the limit", () => {
    const messages = [toolImage("a"), toolImage("b")];
    expect(capToolResultImages(messages, 8)).toBe(messages);
  });

  it("never removes user images even when they alone exceed the limit", () => {
    const messages = [userImage("a"), userImage("b"), userImage("c"), toolImage("t")];
    const capped = capToolResultImages(messages, 2);
    expect(total(capped)).toBe(3);
    expect(imagePartCount(capped[3]!)).toBe(0);
  });

  it("caps on rebuild instead of throwing at the configured limit", () => {
    const messages = Array.from({ length: 20 }, (_, i) => toolImage(`t${i}`));
    expect(() => pruneForRebuild(messages, 10)).not.toThrow();
    expect(total(pruneForRebuild(messages, 10))).toBe(8);
    expect(total(pruneForRebuild(messages, 4))).toBe(4);
  });

  it("reads the limit from the connection, env, or default", () => {
    expect(toolImageLimit(undefined, {})).toBe(DEFAULT_MAX_TOOL_IMAGES);
    expect(toolImageLimit(3, {})).toBe(3);
    expect(toolImageLimit(undefined, { RAKAZO_MAX_TOOL_IMAGES: "20" })).toBe(20);
    expect(toolImageLimit(5, { RAKAZO_MAX_TOOL_IMAGES: "20" })).toBe(5);
    expect(toolImageLimit(undefined, { RAKAZO_MAX_TOOL_IMAGES: "junk" })).toBe(8);
  });

  it("drops thinking after the first rewritten message", () => {
    const assistant: Message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
        { type: "text", text: "ok" },
      ],
      api: "openai-completions",
      provider: "x",
      model: "m",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    const ctx = { messages: [toolImage("a"), assistant, toolImage("b"), toolImage("c")] };
    const capped = withCappedImages(ctx, 2);
    expect(total(capped.messages)).toBe(2);
    expect(texts(capped.messages[1])).toEqual(["ok"]);
    expect(withCappedImages(ctx, 8)).toBe(ctx);
  });
});

describe("overflow detection", () => {
  it("matches explicit overflow errors", () => {
    expect(looksLikeContextOverflow("400: maximum context length exceeded", 10)).toBe(true);
    expect(looksLikeContextOverflow("400: maximum context length exceeded", 0)).toBe(false);
    expect(looksLikeContextOverflow("Too many images in request", 10)).toBe(true);
    expect(looksLikeContextOverflow("413 Payload Too Large", 10)).toBe(true);
  });
  it("treats a bare gateway 400 as overflow only for image-heavy requests", () => {
    const bare = '400: {"message":"Upstream error: 400","type":"invalid_request_error"}';
    expect(looksLikeContextOverflow(bare, 40)).toBe(true);
    expect(looksLikeContextOverflow(bare, 1)).toBe(false);
    expect(looksLikeContextOverflow("401 unauthorized", 40)).toBe(false);
  });
});
