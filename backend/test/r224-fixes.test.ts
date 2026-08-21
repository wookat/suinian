import { describe, it, expect } from "vitest";
import { applyTriageFixes, fixFinanceDirection, fixAaReimburse, demoteEventLog } from "../src/triage";
import { countQueryIntent, degradeFinanceSubsetTerms } from "../src/ask";
import type { TriageResult } from "../src/types";

const NOW = new Date("2026-08-20T12:00:00+08:00");
const TZ = "Asia/Shanghai";

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

function fixed(content: string, triage: TriageResult): TriageResult {
  return applyTriageFixes(content, triage, NOW, TZ);
}

// R224 P2-1（audit-r223 §2.1 误判 #1）：他人付款主语时词面不再是无歧义
// 支出证据，模型主判（修复本体在提示词判例回流）
describe("third-party payer direction (R224 P2-1)", () => {
  it("keeps model income for 房客交了房租", () => {
    const r = fixFinanceDirection("房客交了下季度房租 9000", t("income", { amount: 9000 }));
    expect(r.category).toBe("income");
  });

  it("keeps model expense for 我代他人交费（方向由模型判）", () => {
    const r = fixFinanceDirection("帮客户垫付了材料费，客户付了 2000 给供应商", t("expense"));
    expect(r.category).toBe("expense");
  });

  it("still flips income→expense for self-pay canonical case (R118)", () => {
    expect(fixFinanceDirection("吉他课今天交了下半月学费 400 元", t("income")).category).toBe("expense");
    expect(fixFinanceDirection("付了这个月房租 2600", t("income")).category).toBe("expense");
  });
});

// R224 P2-2（audit-r223 §2.1 误判 #2）：回款动词窗口放宽到整句
describe("AA/advance reimburse whole-sentence window (R224 P2-2)", () => {
  it("flips transfer→income when repay verb is >10 chars from 垫付", () => {
    expect(fixAaReimburse("垫付快递费 23，同事微信还我了", t("transfer")).category).toBe("income");
  });

  it("still respects the pending guard (还没还我)", () => {
    expect(fixAaReimburse("垫付快递费 23，同事还没还我", t("transfer")).category).toBe("transfer");
  });

  it("flips expense→income when model records the reimbursement sentence as expense (聚餐我先付的，AA 收回)", () => {
    expect(fixAaReimburse("公司团建聚餐我先付的，AA 收回 240", t("expense", { amount: 240 })).category).toBe("income");
    // 无回款动词的纯垫付支出不受影响
    expect(fixAaReimburse("帮同事垫付午饭 30", t("expense", { amount: 30 })).category).toBe("expense");
  });

  it("pending guard covers shared reminder cue (待办/记得)", () => {
    expect(fixAaReimburse("AA 餐费 300，记得让他还我", t("transfer")).category).toBe("transfer");
    expect(fixAaReimburse("垫付了 200，记在待办里让他还我", t("transfer")).category).toBe("transfer");
  });
});

// R224（audit-r223 §2 建议 4）：fix* 规则族 conflict 矩阵——同一句被多条规则
// 先后改写的组合用例，锁住 applyTriageFixes 的管线顺序语义
describe("fix* pipeline conflict matrix (R224)", () => {
  it("垫付回款两段链：fixTransferMisfile(→transfer) 后 fixAaReimburse(→income)", () => {
    const r = fixed("垫付快递费 23，同事微信还我了", t("expense", { amount: 23, currency: "CNY" }));
    expect(r.category).toBe("income");
    expect(r.amount).toBe(23);
  });

  it("AA 收回保持 income，不滞留 transfer", () => {
    expect(fixed("公司团建 AA 收回 240", t("transfer", { amount: 240 })).category).toBe("income");
  });

  it("跨天垫付×回款：PAST_ADVANCE 链翻 income 且金额不被净额化", () => {
    const r = fixed("昨天垫付的地铁卡 200，今天他还我 200", t("transfer", { amount: 200 }));
    expect(r.category).toBe("income");
    expect(r.amount).toBe(200);
  });

  it("内转祈使句：todo→transfer 且金额补录", () => {
    const r = fixed("把余额宝的 10000 转到活期", t("todo"));
    expect(r.category).toBe("transfer");
    expect(r.amount).toBe(10000);
  });

  it("带共享提醒词的内转句保持 todo（TRANSFER_INTENT 词表合并无回归）", () => {
    expect(fixed("记得把余额宝的 10000 转到活期", t("todo")).category).toBe("todo");
    expect(fixed("提醒我月底把 5000 转到银行卡", t("todo")).category).toBe("todo");
  });

  it("负债还款：fixFinanceDirection 与 fixTransferMisfile 接力后落 transfer", () => {
    expect(fixed("还了信用卡 3000", t("income", { amount: 3000 })).category).toBe("transfer");
    expect(fixed("还了信用卡 3000", t("expense", { amount: 3000 })).category).toBe("transfer");
  });

  it("借还归还：transfer 不被方向兜底翻转", () => {
    expect(fixed("表弟把上次借的 1500 还给我了", t("transfer", { amount: 1500 })).category).toBe("transfer");
  });

  it("方向修正与事件降级互不干扰：交学费翻 expense 后不再降级", () => {
    const r = fixed("吉他课今天交了下半月学费 400 元", t("income", { amount: 400 }));
    expect(r.category).toBe("expense");
    expect(r.amount).toBe(400);
  });

  it("单金额 AA 回款句不被净额化覆盖：expense 起步全链落 income（R224b 根因）", () => {
    const r = fixed("公司团建聚餐我先付的，AA 收回 240", t("expense", { amount: 240 }));
    expect(r.category).toBe("income");
    expect(r.amount).toBe(240);
    // 模型直接给 income 也不被 fixAdvanceRepayAmount 翻回 expense
    expect(fixed("公司团建聚餐我先付的，AA 收回 240", t("income", { amount: 240 })).category).toBe("income");
  });

  it("双金额垫付×回款净额化不受影响（X、Y 两个金额位置）", () => {
    const r = fixed("聚餐我先付 480，其他人回我 360", t("transfer", { amount: 120 }));
    expect(r.category).toBe("expense");
    expect(r.amount).toBe(480);
  });

  it("第三方付款句从模型 income 起步全链保持 income", () => {
    const r = fixed("房客交了下季度房租 9000", t("income", { amount: 9000 }));
    expect(r.category).toBe("income");
    expect(r.amount).toBe(9000);
  });
});

// 提醒词表合并后 demoteEventLog 语义（SELF_ACTION 共享词源）
describe("demoteEventLog with shared reminder cue", () => {
  it("still demotes booked logs without self action", () => {
    expect(demoteEventLog("已预约周六上午的洗牙", t("todo")).category).toBe("idea");
  });

  it("keeps todo when a reminder cue exists (bare 提醒 now counts)", () => {
    expect(demoteEventLog("已预约洗牙，医生提醒带医保卡", t("todo")).category).toBe("todo");
    expect(demoteEventLog("沙丘 3 十月上映，提醒我提前买票", t("todo")).category).toBe("todo");
  });
});

// R224 P2-3（audit-r223 §4 q10）：待办计数问法必须路由到 SQL 精确计数
describe("todo count question routing (R224 P2-3)", () => {
  it("routes 「我记了几条待办」 to exact category count", () => {
    expect(countQueryIntent("我记了几条待办")).toEqual({
      intent: "exact",
      category: "todo",
      sensitiveOnly: false,
      avgPerDay: false,
    });
    expect(countQueryIntent("我记了几条待办？")?.category).toBe("todo");
    expect(countQueryIntent("待办有几条")?.category).toBe("todo");
  });
});

// R224 P3-1（audit-r223 §4 q5）：亲属称谓口语变体进入降级重试词集
describe("kinship alias in finance subset degrade (R224 P3-1)", () => {
  it("expands 妹妹→我妹 (and reverse)", () => {
    expect(degradeFinanceSubsetTerms(["妹妹"])).toEqual(["妹妹", "我妹"]);
    expect(degradeFinanceSubsetTerms(["我妹"])).toEqual(["我妹", "妹妹"]);
  });

  it("expands kinship embedded in a longer topic phrase (审计原句路径)", () => {
    expect(degradeFinanceSubsetTerms(["妹妹买生日礼物"])).toEqual(["妹妹买生日礼物", "我妹买生日礼物"]);
    expect(degradeFinanceSubsetTerms(["我妹妹的礼物"])?.some((x) => x.includes("我妹"))).toBe(true);
  });

  it("keeps non-kinship terms unchanged (no degrade → null)", () => {
    expect(degradeFinanceSubsetTerms(["咖啡"])).toBeNull();
  });
});
