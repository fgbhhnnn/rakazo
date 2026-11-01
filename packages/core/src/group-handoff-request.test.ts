import { describe, expect, it } from "vitest";
import {
  deferredHandoffTargetId,
  replyBlocksRequestedHandoff,
  replyWaitsOnUser,
  requestedHandoffTarget,
  systemHandoffMarker,
} from "./group-handoff-request.js";

const members = [
  { id: "pm", name: "团队-产品" },
  { id: "be", name: "团队-后端" },
  { id: "fe", name: "团队-前端" },
  { id: "qa", name: "团队-测试" },
  { id: "team", name: "团队" },
  { id: "back", name: "Back" },
  { id: "backend", name: "Backend" },
];
const target = (text: string, self = "pm") =>
  requestedHandoffTarget(text, members, self)?.member.id;

describe("requestedHandoffTarget", () => {
  it("finds the member a human asks the bot to pass the work to", () => {
    expect(target("@团队-产品 写 3 条验收标准，然后交给团队-后端")).toBe("be");
    expect(target("@团队-产品 写需求，然后把接口设计交给团队-后端。")).toBe("be");
    expect(target("@团队-产品 写需求，然后交给@团队-后端")).toBe("be");
    expect(target("@团队-产品 写需求，完成后交给 团队-后端 实现")).toBe("be");
    expect(target("@团队-产品 写完转给团队-测试")).toBe("qa");
    expect(target("@团队-产品 写完交接给团队-前端")).toBe("fe");
    expect(target("@团队-产品 写完转交给团队-前端")).toBe("fe");
    expect(target("@团队-产品 写完移交给＠团队-前端")).toBe("fe");
    expect(target("@团队-产品 write the spec, then hand it off to Backend.")).toBe("backend");
    expect(target("@团队-产品 write the spec and pass it to @Backend")).toBe("backend");
  });

  it("matches exact member names, longest first, CJK-safe", () => {
    // "团队-后端" wins over the shorter member "团队" it starts with.
    expect(target("写完交给团队-后端看")).toBe("be");
    // A bare short role is not an exact member name.
    expect(target("写完交给后端")).toBeUndefined();
    // A Latin name may not run into a longer word.
    expect(target("then hand it to Backends")).toBeUndefined();
    expect(target("then hand it to Back.")).toBe("back");
    expect(target("交给你了")).toBeUndefined();
  });

  it("does not fire on negations, questions, hypotheticals, done-claims or quotes", () => {
    for (const text of [
      "@团队-产品 写需求，先别交给团队-后端",
      "@团队-产品 写需求，不要交给团队-后端",
      "@团队-产品 写需求，不用交给团队-后端",
      "@团队-产品 写需求，暂时不交给团队-后端",
      "@团队-产品 写需求，无需转给团队-后端",
      "@团队-产品 要不要交给团队-后端？",
      "@团队-产品 写完交给团队-后端吗？",
      "@团队-产品 是否交给团队-后端",
      "@团队-产品 如果写完了就交给团队-后端",
      "@团队-产品 我已经交给团队-后端了",
      "@团队-前端 结尾写一句“已交给团队-测试回归”（不用真的交接）",
      "@团队-前端 结尾写一句「交给团队-测试」",
      "@团队-产品 write it, but don't hand it to Backend",
      "@团队-产品 write it; no need to pass it to Backend",
    ]) {
      expect(target(text), text).toBeUndefined();
    }
  });

  it("needs exactly one target that is not the addressed bot", () => {
    expect(target("写完交给团队-后端，测试交给团队-测试")).toBeUndefined();
    expect(target("写完交给团队-产品", "pm")).toBeUndefined();
    expect(target("写完交给团队-后端，再交给团队-后端")).toBe("be");
    expect(requestedHandoffTarget("写完交给团队-后端", [], "pm")).toBeUndefined();
  });

  it("keeps a negation local to its own clause", () => {
    expect(target("@团队-产品 不要写代码，写完需求交给团队-后端")).toBe("be");
  });
});

describe("replyBlocksRequestedHandoff", () => {
  it("blocks on a refusal or a question to the user", () => {
    expect(replyBlocksRequestedHandoff("这个需求我无法交给后端，信息不够。")).toBe(true);
    expect(replyBlocksRequestedHandoff("I can't hand this off yet.")).toBe(true);
    expect(replyBlocksRequestedHandoff("截止日期要支持时间吗？")).toBe(true);
    expect(replyBlocksRequestedHandoff("请确认截止日期是否必填。")).toBe(true);
  });

  it("does not block on an ordinary finished reply", () => {
    expect(
      replyBlocksRequestedHandoff("## 验收标准\n1. 非法日期不能提交，提示「请选择有效日期」。"),
    ).toBe(false);
    expect(replyBlocksRequestedHandoff("需求写好了。")).toBe(false);
  });
});

it("marks the handoff as made by the system", () => {
  expect(systemHandoffMarker("团队-后端")).toBe("（系统按你的要求交给 团队-后端）");
});

describe("any kind of team", () => {
  const writing = [
    { id: "plan", name: "策划" },
    { id: "write", name: "撰稿" },
    { id: "edit", name: "审校" },
  ];
  const trade = [
    { id: "lead", name: "外贸-主管" },
    { id: "follow", name: "外贸-跟单" },
    { id: "docs", name: "外贸-单证" },
  ];

  it("reads the request the same way whatever the members are called", () => {
    expect(requestedHandoffTarget("@策划 写好大纲，然后交给撰稿", writing, "plan")?.member.id).toBe(
      "write",
    );
    expect(requestedHandoffTarget("@撰稿 写完正文转给审校", writing, "write")?.member.id).toBe(
      "edit",
    );
    expect(requestedHandoffTarget("@策划 先别交给撰稿", writing, "plan")).toBeUndefined();
    expect(
      requestedHandoffTarget("@外贸-主管 报价单做好后交给@外贸-单证", trade, "lead")?.member.id,
    ).toBe("docs");
    expect(
      requestedHandoffTarget("@外贸-主管 要不要交给外贸-跟单？", trade, "lead"),
    ).toBeUndefined();
  });
});

describe("deferredHandoffTargetId", () => {
  const writing = [
    { id: "plan", name: "策划" },
    { id: "write", name: "撰稿" },
    { id: "edit", name: "审校" },
  ];

  it("holds back the member named only as the next stage", () => {
    expect(deferredHandoffTargetId("@策划 写大纲，然后交给@撰稿", writing, ["plan", "write"])).toBe(
      "write",
    );
    expect(deferredHandoffTargetId("@撰稿 写完交给@策划 过目", writing, ["write", "plan"])).toBe(
      "plan",
    );
    expect(
      deferredHandoffTargetId("@团队-产品 写需求，然后交给@团队-后端", members, ["pm", "be"]),
    ).toBe("be");
  });

  it("wakes both when the next member is also addressed on its own", () => {
    expect(
      deferredHandoffTargetId("@策划 写大纲，然后交给@撰稿。@撰稿 你先看看资料", writing, [
        "plan",
        "write",
      ]),
    ).toBeUndefined();
  });

  it("only acts on exactly two woken members and a real request", () => {
    expect(
      deferredHandoffTargetId("@策划 @撰稿 一起看看", writing, ["plan", "write"]),
    ).toBeUndefined();
    expect(
      deferredHandoffTargetId("@策划 先别交给@撰稿", writing, ["plan", "write"]),
    ).toBeUndefined();
    expect(
      deferredHandoffTargetId("@策划 写大纲，然后交给@撰稿", writing, ["plan", "write", "edit"]),
    ).toBeUndefined();
    expect(
      deferredHandoffTargetId("@策划 写大纲，然后交给审校", writing, ["plan", "write"]),
    ).toBeUndefined();
  });
});

describe("replyWaitsOnUser", () => {
  it("is true only when the reply ends by asking the user", () => {
    expect(replyWaitsOnUser("大纲有两个方向，你选哪个？")).toBe(true);
    expect(replyWaitsOnUser("请确认预算范围")).toBe(true);
    expect(replyWaitsOnUser("大纲已完成：1. 引言 2. 正文")).toBe(false);
  });
});
