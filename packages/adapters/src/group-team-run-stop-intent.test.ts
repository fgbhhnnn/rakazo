import { describe, expect, it, vi } from "vitest";
import { consumeGroupTeamRunStop, isStopIntent } from "./group-team-run-stop-intent.js";

describe("isStopIntent", () => {
  it.each([
    "停",
    "停下",
    "停一下",
    "先停一下",
    "停止",
    "暂停",
    "别做了",
    "不用做了",
    "先别做了",
    "取消",
    "取消任务",
    "都停下",
    "全部停止",
    "停下来",
    "停一停",
    "请停一下吧",
    "麻烦先暂停一下，谢谢",
    "大家都停下啊",
    "你们先别做了哈",
    "请大家全部停止工作吧",
    "拜托先不用做了",
    "可以先停一下吗",
    "请取消任务。",
    "@产品 先停一下",
    "@产品，@撰稿：全部停止！",
    "先停一下 @产品 @撰稿",
    "⏹️ 先停一下 🙏",
    "🛑停！",
    " 🙏 请，暂停一下吧！谢谢大家 🙏🏽",
    "stop",
    "stop it",
    "please stop",
    "cancel",
    "abort",
    "halt",
    "hold on",
    " STOP! ",
    "ＰＬＥＡＳＥ ＳＴＯＰ",
    "Please, stop!",
    "stop please",
    "stop for now",
    "could you please stop it?",
    "can you cancel the task, please?",
    "everyone stop now",
    "@Product @Writer please stop 🛑",
    "hold on, thanks",
    "stop, thank you",
  ])("recognizes the complete command %j", (text) => {
    expect(isStopIntent(text)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "🙏",
    "@产品",
    "停车场在哪",
    "不停地刷新",
    "停止条件怎么写",
    "the bus stop is near",
    "how do I stop a docker container",
    "暂停功能的设计方案",
    "先停一下的按钮应该放在哪里",
    "不要停止",
    "别停",
    "继续，不要停",
    "先别停",
    "停止不是解决办法",
    "取消任务的接口怎么设计",
    "这个问题不用做了吗",
    "已停",
    "停顿后继续",
    "请解释停止条件",
    "stopping",
    "stopwatch",
    "unstoppable",
    "please stop by the store",
    "don't stop",
    "do not stop",
    "never stop",
    "stop the docker container",
    "please cancel my subscription",
    "abort controller design",
    "hold on to this file",
    "what does stop mean?",
    "stop if there is an error",
    "please design a stop button",
    "stop\nand then start again",
    "@产品 怎么停止任务",
    "请写一份方案，包含暂停、停止和取消任务的设计，最后给出具体实现。",
    `${"先停一下 ".repeat(40)}stop`,
    `${"🙏".repeat(90)}stop`,
  ])("leaves ordinary messages alone: %j", (text) => {
    expect(isStopIntent(text)).toBe(false);
  });
});

describe("group stop admission", () => {
  const message = {
    id: "stop",
    threadId: "thread",
    seq: 5,
    createdAt: new Date(),
    role: "user",
    botId: null,
    blocks: [{ kind: "text", text: "先停一下" }],
  };
  const input = { spaceId: "space", groupId: "group", message };

  it.each([
    { ...message, role: "bot" },
    { ...message, botId: "writer" },
    { ...message, blocks: [...message.blocks, { kind: "bot_message_received" }] },
    { ...message, blocks: [{ kind: "file" }] },
    { ...message, blocks: [{ kind: "text", text: "停止条件怎么写" }] },
  ])("does not inspect or stop teams for non-command/human messages", async (candidate) => {
    const findMany = vi.fn();
    expect(
      await consumeGroupTeamRunStop({ groupTeamRun: { findMany } } as never, {
        ...input,
        message: candidate,
      }),
    ).toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("preserves routing when there is no active team or previous consumed stop", async () => {
    const tx = {
      groupTeamRun: { findMany: vi.fn(async () => []) },
      message: { findFirst: vi.fn(async () => null) },
      run: { create: vi.fn() },
    };
    expect(await consumeGroupTeamRunStop(tx as never, input)).toBeUndefined();
    expect(tx.run.create).not.toHaveBeenCalled();
  });

  it("recognizes a human stop even when the message includes an attachment", async () => {
    const tx = {
      groupTeamRun: { findMany: vi.fn(async () => []) },
      message: { findFirst: vi.fn(async () => null) },
    };
    await consumeGroupTeamRunStop(tx as never, {
      ...input,
      message: { ...message, blocks: [...message.blocks, { kind: "file" }] },
    });
    expect(tx.groupTeamRun.findMany).toHaveBeenCalledOnce();
  });
});
