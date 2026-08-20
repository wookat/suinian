// R210（audit-r209）：
// P2-1 显式分隔符台账首行为负数尾注行时被表头启发式误吞致合计虚增——
//      单元格统一过 splitTrailingNote，含金额的行绝不当表头。
// P2-2 短句混合正负（净额为正含退款/负数项）方向错误率 25%——短句多笔按
//      「名目 金额」对切成伪行走台账同一识别口径（不新增平行逻辑），
//      净额符号与模型方向矛盾且词面无该方向证据时按净额仲裁。
// P3-1 「下周日」被算进本周——「下周X」确定性后校验（周一起始周口径）。
// P3-2 「耳机和键盘一共花了多少」复合关键词粘连零命中——连接词先切段再剥离。
import { describe, it, expect } from "vitest";
import { parseLedgerCore, fixFinanceDirection, fixLedgerAmount, fixLedgerNetDirection, fixWeekdayDue } from "../src/triage";
import type { TriageResult } from "../src/types";
import { financeTopicTerms, financeShortTopicTerms } from "../src/ask";

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

describe("显式分隔符首行负数尾注不被表头吞行 (R210 P2-1)", () => {
  it("半角逗号：首行负数尾注行计入合计（5.5 而非 40）", () => {
    expect(parseLedgerCore("快递费,-34.5 (破损赔付)\n文具,28\n打印,12")).toEqual({ amount: 5.5, rows: 3 });
  });
  it("全角逗号/制表符分隔口径一致", () => {
    expect(parseLedgerCore("快递费，-34.5 (破损赔付)\n文具，28\n打印，12")).toEqual({ amount: 5.5, rows: 3 });
    expect(parseLedgerCore("快递费\t-34.5 (破损赔付)\n文具\t28\n打印\t12")).toEqual({ amount: 5.5, rows: 3 });
  });
  it("负数尾注行在中间/末位仍正确（回归）", () => {
    expect(parseLedgerCore("文具,28\n快递费,-34.5 (破损赔付)\n打印,12")).toEqual({ amount: 5.5, rows: 3 });
    expect(parseLedgerCore("文具,28\n打印,12\n快递费,-34.5 (破损赔付)")).toEqual({ amount: 5.5, rows: 3 });
  });
  it("真表头（首行无金额）仍被跳过", () => {
    expect(parseLedgerCore("名目,金额\n文具,28\n打印,12")).toEqual({ amount: 40, rows: 2 });
  });
  it("正数尾注单元同样归一（尾注并回名目，退款语义不丢）", () => {
    expect(parseLedgerCore("咖啡,12 (商家退款)\n文具,28\n打印,12")).toEqual({ amount: 28, rows: 3 });
  });
});

describe("短句混合正负走台账管道 (R210 P2-2)", () => {
  it("空格短句「午饭 20 咖啡 -5(退款)」净额 15", () => {
    expect(parseLedgerCore("午饭 20 咖啡 -5(退款)")).toEqual({ amount: 15, rows: 2 });
  });
  it("逗号/全角括号/斜杠/负数行在前的形态一致", () => {
    expect(parseLedgerCore("午饭 20，咖啡 -5（退款）")).toEqual({ amount: 15, rows: 2 });
    expect(parseLedgerCore("午饭 20/咖啡 -5(退款)")).toEqual({ amount: 15, rows: 2 });
    expect(parseLedgerCore("咖啡 -5(退款) 午饭 20")).toEqual({ amount: 15, rows: 2 });
  });
  it("净额为负的退货短句（净收入语义）", () => {
    expect(parseLedgerCore("零食 8 退货 -30(质量差)")).toEqual({ amount: -22, rows: 2 });
  });
  it("显式支出动词前缀不影响识别", () => {
    expect(parseLedgerCore("今天花了：午饭 20 咖啡 -5(退款)")).toEqual({ amount: 15, rows: 2 });
  });
  it("两段短句门槛：非退款负数/纯正数/合计短句不误认", () => {
    expect(parseLedgerCore("纪念品退款 -30，合计 224")).toBeNull();
    expect(parseLedgerCore("房租 3000，水电 200")).toBeNull();
    expect(parseLedgerCore("工资 8000 代缴 -240")).toBeNull();
  });
  it("数量词不当金额（「2 杯咖啡」）", () => {
    expect(parseLedgerCore("买了 2 杯咖啡 35 一杯奶茶 12")).toBeNull();
  });
  it("台账命中后整条词面兜底跳过（R196 口径延续到短句）", () => {
    expect(fixFinanceDirection("午饭 20 咖啡 -5(退款)", t("expense")).category).toBe("expense");
  });
});

describe("fixLedgerNetDirection 净额方向仲裁 (R210 P2-2)", () => {
  const pipe = (c: string, cat: TriageResult["category"]) =>
    fixLedgerNetDirection(c, fixLedgerAmount(c, fixFinanceDirection(c, t(cat))));
  it("净正额短句被模型判 income 且无收入词面证据 → expense 净额", () => {
    const out = pipe("午饭 20 咖啡 -5(退款)", "income");
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(15);
  });
  it("净负额退货短句模型判 expense 且无支出词面证据 → income 绝对值", () => {
    const out = pipe("零食 8 退货 -30(质量差)", "expense");
    expect(out.category).toBe("income");
    expect(out.amount).toBe(22);
  });
  it("有收入词面证据的净正混合台账 income 不动（收款）", () => {
    const out = pipe("客户收款台账\n项目款,8000\n客户退款,500", "income");
    expect(out.category).toBe("income");
    expect(out.amount).toBe(7500);
  });
  it("有支出词面证据的净负台账 expense 不动", () => {
    const out = pipe("今天花了：零食 8 退货 -30(质量差)", "expense");
    expect(out.category).toBe("expense");
  });
  it("合计行台账以合计为口径不仲裁（R196 回归）", () => {
    const c = "上周办公台账：\n打印纸 120\n工位绿植 368.5\n快递退款 -34.5\n合计 454";
    const out = pipe(c, "expense");
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(454);
  });
  it("正数退款行冲减台账（R206 回归）方向金额不变", () => {
    const c = "办公用品台账\n打印纸 120\n墨盒 260\n耗材 300\n供应商退款 454";
    const out = pipe(c, "expense");
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(226);
  });
});

describe("「下周X」相对日期后校验 (R210 P3-1)", () => {
  // 2026-08-20 = 周四（Asia/Shanghai）
  const now = new Date("2026-08-20T02:00:00Z");
  const todo = (due: string) => t("todo", { todo_due: due });
  it("「下周日」被算进本周 → 纠正到下个日历周的周日", () => {
    const out = fixWeekdayDue("下周日晚上8点和爸妈视频", todo("2026-08-23T20:00:00+08:00"), now, "Asia/Shanghai");
    expect(out.todo_due).toBe("2026-08-30T20:00:00+08:00");
  });
  it("LLM 已正确的「下周三」不动", () => {
    const out = fixWeekdayDue("下周三下午2点开产品评审会", todo("2026-08-26T14:00:00+08:00"), now, "Asia/Shanghai");
    expect(out.todo_due).toBe("2026-08-26T14:00:00+08:00");
  });
  it("「下下周一」不适用下周口径（歧义不猜）", () => {
    const out = fixWeekdayDue("下下周一提交项目方案", todo("2026-08-31"), now, "Asia/Shanghai");
    expect(out.todo_due).toBe("2026-08-31");
  });
  it("裸「周X」既有口径回归（周五→本周五）", () => {
    const out = fixWeekdayDue("周五下午3点交季度报告", todo("2026-08-22T15:00:00+08:00"), now, "Asia/Shanghai");
    expect(out.todo_due).toBe("2026-08-21T15:00:00+08:00");
  });
  it("裸周X与下周X同现（歧义）不动", () => {
    const out = fixWeekdayDue("周五交周报，下周五交报销", todo("2026-08-22T15:00:00+08:00"), now, "Asia/Shanghai");
    expect(out.todo_due).toBe("2026-08-22T15:00:00+08:00");
  });
});

describe("复合关键词子集合计逐词切段 (R210 P3-2)", () => {
  it("「和」连接的复合主题拆成多词", () => {
    expect(financeTopicTerms("耳机和键盘一共花了多少")).toEqual(["耳机", "键盘"]);
  });
  it("顿号/与/三词形态", () => {
    expect(financeTopicTerms("耳机、键盘和鼠标一共花了多少钱")).toEqual(["耳机", "键盘", "鼠标"]);
    expect(financeTopicTerms("耳机与键盘一共花了多少")).toEqual(["耳机", "键盘"]);
  });
  it("单主题行为不变（R148 回归）", () => {
    expect(financeTopicTerms("咖啡一共花了多少")).toEqual(["咖啡"]);
  });
  it("短问法共用同一切段口径", () => {
    expect(financeShortTopicTerms("耳机和键盘多少钱")).toEqual(["耳机", "键盘"]);
  });
});
