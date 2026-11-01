import { describe, expect, it } from "vitest";
import { incompleteResultReason, saysWorkUnfinished } from "./worker-incomplete-result.js";
import {
  CLOSING_TAIL_CHARS,
  closingProse,
  closingSaysUnfinished,
} from "./worker-unfinished-closing.js";

/**
 * Anonymized final text from the #TZ5P9D3Y incident: a project summary the user asked for,
 * with a "进行中或未完成事项" section, complete sections 6 and 7, and no unfinished sign-off.
 * The old whole-text detector matched 未完成 in the heading and failed the task.
 */
const TZ5P9D3Y_FINAL = `摘要已完成。文件未改。

## 1. 项目背景
示例项目是一个面向门店的预约应用，前端用 Expo，后端用 Node 服务，数据在 Postgres。

## 2. 已完成的工作
- 首页、预约页和个人中心三套界面已按设计稿重做并合入 feat/app-features。
- 支付回调接入沙箱环境，签名校验通过。
- 预约提醒改为服务端定时任务，重复推送的问题已修复。

## 3. 关键决定
| 事项 | 结论 |
| --- | --- |
| 登录方式 | 先保留短信验证码，暂不接第三方登录 |
| 发版节奏 | 每两周一个版本 |

## 4. 当前状态
主分支可构建，测试全部通过，测试服已部署 v1.2.0-rc1。

## 5. 进行中或未完成事项
- 支付回调的失败重试逻辑尚未完成，目前只记录日志。
- 未完成：iOS 正式签名证书还没申请。
- 安卓推送在部分机型上不稳定，仍在排查。

## 6. 风险
- 第三方短信通道有频率限制，高峰期可能延迟。
- 签名证书申请需要公司资质，周期不可控。

## 7. 下一步建议
1. 让用户拍板 v1.2 是否按现有范围上线。
2. 先补完支付重试，再申请 iOS 证书。
3. 安卓推送问题单独开一个任务跟进。`;

/** The same summary rewritten with the other heading wording seen in the incident. */
const TZ5P9D3Y_REWRITE = TZ5P9D3Y_FINAL.replace("## 5. 进行中或未完成事项", "## 5. 进行中与未完成");

const ENGLISH_SUMMARY = `Summary is ready.

## Done
- Rebuilt the booking screens.
- Payment callbacks verified in sandbox.

## Incomplete items
- Retry logic for failed callbacks is incomplete.
- iOS release certificate not finished yet.

## Next steps
1. Confirm the v1.2 scope.
2. Request the iOS certificate.`;

describe("closing-paragraph unfinished detector", () => {
  it("returns null for the anonymized #TZ5P9D3Y final summary", () => {
    expect(incompleteResultReason(TZ5P9D3Y_FINAL)).toBeNull();
    expect(incompleteResultReason(TZ5P9D3Y_REWRITE)).toBeNull();
  });

  it("returns null for a '## 5. 进行中或未完成事项' heading section", () => {
    const text = "## 5. 进行中或未完成事项\n- 支付重试未完成\n- 证书还没做完";
    expect(incompleteResultReason(text)).toBeNull();
    expect(incompleteResultReason("## 5. 进行中或未完成事项")).toBeNull();
  });

  it("returns null for an English 'Incomplete items' heading", () => {
    expect(incompleteResultReason(ENGLISH_SUMMARY)).toBeNull();
    expect(incompleteResultReason("## Incomplete items\n- auth refactor incomplete")).toBeNull();
  });

  it("ignores table rows that mention unfinished work", () => {
    const text = "结果如下。\n\n| 任务 | 状态 |\n| --- | --- |\n| 证书 | 还没做完，稍后继续 |";
    expect(incompleteResultReason(text)).toBeNull();
  });

  it("drops bare 未完成 and incomplete in closing prose", () => {
    expect(saysWorkUnfinished("总结已写好，其中两项未完成，已列在上面。")).toBe(false);
    expect(saysWorkUnfinished("The report lists the incomplete migrations above.")).toBe(false);
  });

  it("still flags a genuine '我还没做完，稍后继续' ending", () => {
    const text = `${TZ5P9D3Y_FINAL}\n\n我还没做完，稍后继续。`;
    expect(incompleteResultReason(text)).toBe("unfinished_phrase");
    expect(incompleteResultReason("首页改好了一半，我还没做完，稍后继续。")).toBe(
      "unfinished_phrase",
    );
  });

  it("flags unfinished prose that leads into a closing list", () => {
    const text = "我还没做完，剩下这些稍后继续：\n- 支付重试\n- iOS 证书";
    expect(incompleteResultReason(text)).toBe("unfinished_phrase");
  });

  it("does not read unfinished wording far before the closing part", () => {
    const filler = "已核对的条目说明。".repeat(100);
    const text = `我还没做完，稍后继续。\n\n${filler}\n\n全部内容见上。`;
    expect(text.length).toBeGreaterThan(CLOSING_TAIL_CHARS * 2);
    expect(incompleteResultReason(text)).toBeNull();
  });

  it("stops reading lines once the closing part is long enough", () => {
    // Four short closing lines already exceed the window, so the first line is not read even
    // though the whole reply would fit in the long-paragraph cut.
    const line = "这一段是已经核对过的说明，内容完整。".repeat(5);
    const text = `我还没做完，稍后继续。\n${[line, line, line, line].join("\n")}`;
    expect(text.length).toBeLessThan(CLOSING_TAIL_CHARS * 2);
    expect(closingProse(text)).not.toContain("稍后继续");
    expect(incompleteResultReason(text)).toBeNull();
  });

  it("reads only the end of one long closing paragraph", () => {
    const text = `我还没做完，稍后继续。${"已核对的条目说明。".repeat(80)}`;
    expect(text.includes("\n")).toBe(false);
    expect(closingProse(text)).toHaveLength(CLOSING_TAIL_CHARS * 2);
    expect(incompleteResultReason(text)).toBeNull();
  });

  it("keeps only prose lines in the closing part", () => {
    expect(closingProse("## 标题\n- 列表\n| a | b |\n---\n收尾一句。")).toBe("收尾一句。");
    expect(closingSaysUnfinished("")).toBe(false);
  });

  it("flags English self-referential unfinished closings", () => {
    expect(saysWorkUnfinished("Rebuilt two screens. I'll continue with the rest next.")).toBe(true);
    expect(saysWorkUnfinished("We will finish the tab bar in the next run.")).toBe(true);
    expect(saysWorkUnfinished("The API will continue to return 404 for old ids.")).toBe(false);
  });
});
