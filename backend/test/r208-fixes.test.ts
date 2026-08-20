// R208（audit-r207）：
// P2-1 台账负数行带括号尾注（「咖啡 -12 (商家退款)」）整行退化成单字段后
//      被落款剥离逻辑静默丢行，总额虚增（59.5 实应 47.5）→ splitCsvFields
//      空白退化分支剥离段尾括号尾注后再识别金额段，尾注并入名目列。
// P2-2 裸「周X」相对日期 LLM 星期算术系统性 +1 天（生产 3/3 复现）→
//      fixWeekdayDue 确定性后校验：内容唯一提到一个裸周X 且 due 星期不符时
//      按用户时区「最近的该星期」纠正日期，时刻不动；歧义/显式日期不动。
import { describe, it, expect } from "vitest";
import { parseLedgerCore, splitCsvFields, fixLedgerAmount, fixWeekdayDue } from "../src/triage";
import type { TriageResult } from "../src/types";

const t = (category: TriageResult["category"], extra: Partial<TriageResult> = {}): TriageResult => ({
  category,
  title: null,
  tags: [],
  todo_due: null,
  is_sensitive: false,
  amount: null,
  currency: null,
  ...extra,
});

// audit-r207 §2.1 #27 生产原文
const NOTE_LEDGER = "今日消费\n早餐 12.5\n打车 35\n奶茶 12\n咖啡 -12 (商家退款)";

describe("台账负数行括号尾注 (R208 P2-1)", () => {
  it("生产原文：负数尾注行不丢，净额 47.5", () => {
    expect(parseLedgerCore(NOTE_LEDGER)).toEqual({ amount: 47.5, rows: 4 });
  });
  it("模型金额 59.5 被 fixLedgerAmount 锁回净额 47.5", () => {
    expect(fixLedgerAmount(NOTE_LEDGER, t("expense", { amount: 59.5, currency: "CNY" })).amount).toBe(47.5);
  });
  it("全角括号尾注同口径（「退款 -30（部分退）」）", () => {
    const ledger = "周末出行\n车费 46\n门票 120\n退款 -30（部分退）";
    expect(parseLedgerCore(ledger)).toEqual({ amount: 136, rows: 3 });
  });
  it("splitCsvFields：尾注剥离后切成 [名目(含尾注), 金额]", () => {
    expect(splitCsvFields("咖啡 -12 (商家退款)")).toEqual(["咖啡 (商家退款)", "-12"]);
    expect(splitCsvFields("退款 -30（部分退）")).toEqual(["退款 （部分退）", "-30"]);
  });
  it("末段本身是金额时口径不变（既有形态零回归）", () => {
    expect(splitCsvFields("早餐 豆浆油条 12.5")).toEqual(["早餐 豆浆油条", "12.5"]);
    expect(splitCsvFields("供应商退款 454")).toEqual(["供应商退款", "454"]);
  });
  it("多个金额段歧义不猜，保持单字段", () => {
    expect(splitCsvFields("12 报销 30 (待核)")).toHaveLength(1);
  });
  it("纯说明行（无金额段）保持单字段，仍走落款剥离", () => {
    expect(splitCsvFields("以上为本周记录 (含退款)")).toHaveLength(1);
  });
  it("正数金额带尾注行同样保留", () => {
    const ledger = "采购\n胶带 20\n标签纸 45.5 (两包)";
    expect(parseLedgerCore(ledger)).toEqual({ amount: 65.5, rows: 2 });
  });
});

// 2026-08-19 是周三（Asia/Shanghai）
const NOW = new Date("2026-08-19T04:00:00Z");
const TZ = "Asia/Shanghai";
const todo = (due: string): TriageResult => t("todo", { todo_due: due });

describe("裸「周X」due 星期后校验 (R208 P2-2)", () => {
  it("生产复现：裸「周五」被 LLM 判成周六 → 纠回最近的周五", () => {
    const fixed = fixWeekdayDue("周五下午3点交季度报告", todo("2026-08-22T15:00:00+08:00"), NOW, TZ);
    expect(fixed.todo_due).toBe("2026-08-21T15:00:00+08:00");
  });
  it("纯日期 due 同样纠正", () => {
    expect(fixWeekdayDue("周五交周报", todo("2026-08-22"), NOW, TZ).todo_due).toBe("2026-08-21");
  });
  it("「本周五」同口径纠正", () => {
    expect(fixWeekdayDue("本周五交周报", todo("2026-08-22"), NOW, TZ).todo_due).toBe("2026-08-21");
  });
  it("周日/周天按 0 处理", () => {
    expect(fixWeekdayDue("周日大扫除", todo("2026-08-24"), NOW, TZ).todo_due).toBe("2026-08-23");
    expect(fixWeekdayDue("周天大扫除", todo("2026-08-24"), NOW, TZ).todo_due).toBe("2026-08-23");
  });
  it("due 星期已正确时不动（LLM 主判）", () => {
    const due = "2026-08-21T15:00:00+08:00";
    expect(fixWeekdayDue("周五下午3点交季度报告", todo(due), NOW, TZ).todo_due).toBe(due);
  });
  it("「下周X」不属裸周X，不动", () => {
    const due = "2026-08-24";
    expect(fixWeekdayDue("下周一晚上8点回邮件", todo(due), NOW, TZ).todo_due).toBe(due);
  });
  it("含显式日期/其它相对日词时不动（明天/月底/X号）", () => {
    for (const c of ["明天上午10点开会", "月底前交报销", "25号交房租", "8月22日聚餐 周五也行"]) {
      const due = "2026-08-22";
      expect(fixWeekdayDue(c, todo(due), NOW, TZ).todo_due).toBe(due);
    }
  });
  it("多个不同周X歧义不猜", () => {
    const due = "2026-08-22";
    expect(fixWeekdayDue("周五或周六都行", todo(due), NOW, TZ).todo_due).toBe(due);
  });
  it("非 todo / 无 due 不动", () => {
    expect(fixWeekdayDue("周五的会很无聊", t("idea"), NOW, TZ)).toEqual(t("idea"));
    expect(fixWeekdayDue("周五交报告", t("todo"), NOW, TZ)).toEqual(t("todo"));
  });
  it("今天就是目标星期时取今天（不跳下周）", () => {
    // NOW 为周三
    expect(fixWeekdayDue("周三交材料", todo("2026-08-20"), NOW, TZ).todo_due).toBe("2026-08-19");
  });
});
