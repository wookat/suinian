import { describe, it, expect } from "vitest";
import { financeListFollowUpIntent, financeAggIntent, parseTimeRange } from "../src/ask";

// R248 P1（audit-r247 F-1）：财务聚合答案后的裸列举追问识别。
// 上一轮是精确合计答案（尾注标识）且本轮是不带主题词的裸列举追问时，
// 方向词只认本轮原问题；纯泛列举返回 "generic"（只关改写产物财务回退）。

const AGG =
  "这个月共记录 5 笔支出、1 笔收入。\n- CNY：支出 ¥735.00，收入 ¥12000.00，结余 ¥11265.00\n\n以上为精确统计，口径与周报/月报一致；时间范围按笔记记录时间划定，不按正文里写的时间。";

describe("financeListFollowUpIntent (R248 P1, audit-r247 F-1)", () => {
  it("带财务线索的裸列举追问返回方向（R247 失败矩阵三变体）", () => {
    expect(financeListFollowUpIntent("分别是哪几笔？", AGG)).toBe("both");
    expect(financeListFollowUpIntent("都花在什么上了？", AGG)).toBe("expense");
    expect(financeListFollowUpIntent("钱都花在哪了？", AGG)).toBe("expense");
    expect(financeListFollowUpIntent("有哪些支出？", AGG)).toBe("expense");
    expect(financeListFollowUpIntent("收入都有哪些？", AGG)).toBe("income");
    expect(financeListFollowUpIntent("账单明细呢？", AGG)).toBe("both");
  });

  it("纯泛列举追问返回 generic（路由层继承上一轮口径按收支双向列举）", () => {
    expect(financeListFollowUpIntent("能列一下吗？", AGG)).toBe("generic");
    expect(financeListFollowUpIntent("都有哪些？", AGG)).toBe("generic");
    expect(financeListFollowUpIntent("具体有哪些记录？", AGG)).toBe("generic");
  });

  it("残留主题词的追问不是裸列举：留给主题子集/普通召回", () => {
    expect(financeListFollowUpIntent("买了哪些书？", AGG)).toBeNull();
    expect(financeListFollowUpIntent("键盘相关的有哪些？", AGG)).toBeNull();
  });

  it("上一轮不是精确合计答案时不触发", () => {
    expect(financeListFollowUpIntent("分别是哪几笔？", null)).toBeNull();
    expect(financeListFollowUpIntent("分别是哪几笔？", "你最近记了几条关于咖啡馆的想法 [1]。")).toBeNull();
  });

  it("无列举线索或超长问题不触发", () => {
    expect(financeListFollowUpIntent("那上个月呢？", AGG)).toBeNull();
    expect(financeListFollowUpIntent("帮我把这个月每一笔支出按类别整理成一张详细的表格好吗？", AGG)).toBeNull();
  });
});

// R248 P3（audit-r247 F-3）：「X月到现在」类开放时间窗问法。
describe("parseTimeRange X月到现在 (R248 P3, audit-r247 F-3)", () => {
  const now = new Date("2026-08-22T10:00:00Z");

  it("「8月到现在」解析为 8月初起、终点开放", () => {
    const r = parseTimeRange("8月到现在一共支出多少", now);
    expect(r).not.toBeNull();
    expect(r!.start).toBe("2026-07-31 16:00:00");
    expect(r!.end).toBeNull();
    expect(r!.phrase).toBe("2026年8月到现在"); // R296 P1-4：裸月份显式回写生效年份
  });

  it("「6月以来」「7月份至今」同口径开放终点", () => {
    const a = parseTimeRange("6月以来花了多少钱", now);
    expect(a!.start).toBe("2026-05-31 16:00:00");
    expect(a!.end).toBeNull();
    const b = parseTimeRange("7月份至今收入多少", now);
    expect(b).not.toBeNull();
    expect(b!.start).toBe("2026-06-30 16:00:00");
  });

  it("「8月到9月」不落入开放窗分支", () => {
    const r = parseTimeRange("8月到9月支出多少", now);
    expect(r).not.toBeNull();
    expect(r!.end).not.toBeNull();
  });

  it("「8月到现在一共支出多少」走精确聚合而非 fail-closed", () => {
    expect(financeAggIntent("8月到现在一共支出多少")).toBe("exact");
  });
});
