import { describe, it, expect } from "vitest";
import { fixAaReimburse, fixAdvanceRepayAmount, fixTransferMisfile } from "../src/triage";
import type { TriageResult } from "../src/types";

const t = (over: Partial<TriageResult> = {}): TriageResult => ({
  category: "expense",
  tags: [],
  title: "t",
  is_sensitive: false,
  todo_due: null,
  amount: null,
  currency: "CNY",
  merchant: null,
  ...over,
});

// ---- P2-1'：跨日垫付回款仍判 transfer（audit-r219 §1）----

describe("R220 P2-1' fixAaReimburse 跨日垫付回款", () => {
  it("「昨天垫付的地铁卡 200，今天他还我 200」transfer → income", () => {
    const out = fixAaReimburse("昨天垫付的地铁卡 200，今天他还我 200", t({ category: "transfer", amount: 200 }));
    expect(out.category).toBe("income");
    expect(out.amount).toBe(200);
  });

  it("「朋友把上次帮他垫的 300 元还我了」（无「垫付」全词）transfer → income", () => {
    const out = fixAaReimburse("朋友把上次帮他垫的 300 元还我了", t({ category: "transfer", amount: 300 }));
    expect(out.category).toBe("income");
  });

  it("「上周帮部门垫付的 560 打车费，今天转我了」transfer → income", () => {
    const out = fixAaReimburse("上周帮部门垫付的 560 打车费，今天转我了", t({ category: "transfer", amount: 560 }));
    expect(out.category).toBe("income");
  });

  it("「前天团建 AA 我垫付的钱，今天收回 300」transfer → income", () => {
    const out = fixAaReimburse("前天团建 AA 我垫付的钱，今天收回 300", t({ category: "transfer", amount: 300 }));
    expect(out.category).toBe("income");
  });

  it("未回款句「昨天垫付的 300 他还没还我」不收口", () => {
    const triage = t({ category: "transfer", amount: 300 });
    const out = fixAaReimburse("昨天垫付的 300 他还没还我", triage);
    expect(out).toBe(triage);
  });

  it("借还往来「表弟把上次借的 1500 还给我了」保持 transfer（无垫付语义）", () => {
    const triage = t({ category: "transfer", amount: 1500 });
    const out = fixAaReimburse("表弟把上次借的 1500 还给我了", triage);
    expect(out).toBe(triage);
  });

  it("既有同句形态「上次垫付的聚餐钱，同事今天转我 360 元」保留（R218 回归）", () => {
    const out = fixAaReimburse("上次垫付的聚餐钱，同事今天转我 360 元", t({ category: "transfer", amount: 360 }));
    expect(out.category).toBe("income");
  });

  it("既有「AA 收回」行为保留（R212 回归）", () => {
    const out = fixAaReimburse("公司团建 AA 收回 240", t({ category: "transfer", amount: 240 }));
    expect(out.category).toBe("income");
  });
});

describe("R220 P2-1' 跨日追记不触发同句净额化收口（R218 回归）", () => {
  it("「上周垫付 480，今天他们回我 360」金额保持回款事件口径", () => {
    const triage = t({ category: "income", amount: 360 });
    const out = fixAdvanceRepayAmount("上周垫付 480，今天他们回我 360", triage);
    expect(out).toBe(triage);
  });

  it("同句垫付×回款仍收口为实付总额（R218 回归）", () => {
    const out = fixAdvanceRepayAmount(
      "我先付了聚餐 480 元，其他人回我 360 元",
      t({ category: "transfer", amount: 120 })
    );
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(480);
  });
});

// ---- P3-4：自有账户内转被判 todo 且金额丢失（audit-r219 §P3-4）----

describe("R220 P3-4 fixTransferMisfile 内转句判 todo", () => {
  it("「把余额宝的 10000 转到活期」todo → transfer 且补录唯一金额", () => {
    const out = fixTransferMisfile("把余额宝的 10000 转到活期", t({ category: "todo", amount: null }));
    expect(out.category).toBe("transfer");
    expect(out.amount).toBe(10000);
    expect(out.currency).toBe("CNY");
  });

  it("模型已给金额时不覆盖", () => {
    const out = fixTransferMisfile("把余额宝的 10000 转到活期", t({ category: "todo", amount: 10000 }));
    expect(out.category).toBe("transfer");
    expect(out.amount).toBe(10000);
  });

  it("多个数字时金额不猜（保持 null）", () => {
    const out = fixTransferMisfile("把余额宝的 10000 转 2000 到活期", t({ category: "todo", amount: null }));
    expect(out.category).toBe("transfer");
    expect(out.amount).toBe(null);
  });

  it("带「记得」的未来内转保持 todo", () => {
    const triage = t({ category: "todo" });
    const out = fixTransferMisfile("记得把余额宝的 10000 转到活期", triage);
    expect(out).toBe(triage);
  });

  it("带 todo_due 的计划内转保持 todo", () => {
    const triage = t({ category: "todo", todo_due: "2026-08-21" });
    const out = fixTransferMisfile("周五把余额宝的 10000 转到活期", triage);
    expect(out).toBe(triage);
  });

  it("非内转待办不受影响", () => {
    const triage = t({ category: "todo" });
    const out = fixTransferMisfile("月底前记得去交电费", triage);
    expect(out).toBe(triage);
  });

  it("expense/income 内转改判 transfer 行为不变（R120 回归）", () => {
    const out = fixTransferMisfile("微信零钱提现 2000 到银行卡", t({ category: "expense", amount: 2000 }));
    expect(out.category).toBe("transfer");
  });
});
