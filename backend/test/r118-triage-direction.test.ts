import { describe, it, expect } from "vitest";
import { fixFinanceDirection, demoteEventLog } from "../src/triage";
import type { TriageResult } from "../src/types";

function t(category: TriageResult["category"], extra: Partial<TriageResult> = {}): TriageResult {
  return {
    category,
    tags: [],
    title: "t",
    is_sensitive: false,
    todo_due: null,
    amount: null,
    currency: null,
    merchant: null,
    ...extra,
  };
}

describe("fixFinanceDirection (R118 P1)", () => {
  it("flips income→expense when only outflow evidence exists (交学费)", () => {
    const r = fixFinanceDirection("吉他课今天交了下半月学费 400 元", t("income", { amount: 400 }));
    expect(r.category).toBe("expense");
    expect(r.amount).toBe(400);
  });

  it("flips income→expense for 付了/还了/缴了", () => {
    expect(fixFinanceDirection("付了这个月房租 2600", t("income")).category).toBe("expense");
    expect(fixFinanceDirection("还了信用卡 3000", t("income")).category).toBe("expense");
    expect(fixFinanceDirection("物业费缴了 1800", t("income")).category).toBe("expense");
  });

  it("flips expense→income when only inflow evidence exists (退款/到账/卖了)", () => {
    expect(fixFinanceDirection("退货的鞋退款 269 已收到", t("expense")).category).toBe("income");
    expect(fixFinanceDirection("上月报销的差旅费 800 到账了", t("expense")).category).toBe("income");
    expect(fixFinanceDirection("闲鱼卖了旧显示器 350 元", t("expense")).category).toBe("income");
  });

  it("keeps model verdict when evidence is ambiguous (给我 + 交了)", () => {
    expect(fixFinanceDirection("学生给我交了补课费 300", t("income")).category).toBe("income");
  });

  it("keeps correct verdicts untouched", () => {
    expect(fixFinanceDirection("午饭黄焖鸡 23 块", t("expense")).category).toBe("expense");
    expect(fixFinanceDirection("报销到账 1200", t("income")).category).toBe("income");
  });

  it("ignores non-finance categories", () => {
    expect(fixFinanceDirection("交了季度报告", t("idea")).category).toBe("idea");
  });
});

describe("demoteEventLog (R118 P2)", () => {
  it("demotes completed-action logs misfiled as todo", () => {
    expect(demoteEventLog("闲鱼挂出了显示器，350 出", t("todo")).category).toBe("idea");
    expect(demoteEventLog("季度报告初稿写完了", t("todo")).category).toBe("idea");
  });

  it("demotes external announcements without user action to data", () => {
    const r = demoteEventLog("沙丘 3 定档 10 月 1 日上映", t("todo", { todo_due: "2026-10-01" }));
    expect(r.category).toBe("data");
    expect(r.todo_due).toBeNull();
  });

  it("keeps todos containing user actions", () => {
    expect(demoteEventLog("沙丘 3 十月上映，提醒我提前买票", t("todo")).category).toBe("todo");
    expect(demoteEventLog("回头把冰箱滤芯换了", t("todo")).category).toBe("todo");
    expect(demoteEventLog("周末记得去买猫粮", t("todo")).category).toBe("todo");
  });

  it("keeps dated todos with completed verbs (交了 in future context has due)", () => {
    expect(demoteEventLog("明天把报告交了", t("todo", { todo_due: "2026-08-15" })).category).toBe("todo");
  });
});
