/**
 * R318 C2（audit-r317 §7.3：ask-eval 10/141 整答只剩裸〔原文查看〕、3/141 概括后附指引）：
 * 聚合层收口把全部实义文本收掉后，出口不再把零信息占位递给用户，而是用列举出口
 * 同口径的结构化字段（分类/标题/日期 + 角标）组成「概括 + 指引」；标题与资料面
 * 重叠 ≥LCS8 时整条退化为「分类 + 日期」（fail-closed）；正文再过一次 finalizeAskAnswer
 * 复审不得改写。R314 P1-1 的 collapsePlaceholderWall 只接「部分行有实义」的墙，本出口
 * 接住它漏掉的「全部实义都被收口」的情形。
 */
import { describe, it, expect } from "vitest";
import {
  aggregateGuideAnswer,
  isBareVerbatimNotice,
  finalizeAskAnswer,
  closeAggregateVerbatim,
  collapsePlaceholderWall,
  AGGREGATE_TIER,
  AGGREGATE_GUIDE_LEAD,
  AGGREGATE_VERBATIM_GUIDE,
  VERBATIM_REDIRECT_NOTICE,
  VERBATIM_SPAN_PLACEHOLDER,
} from "../src/prompt-armor";
import { aggregateGuideItem, ledgerAmountText } from "../src/index";
import type { NoteRow } from "../src/types";

const UNITS = [
  "为什么觉得方案A不行\n方案A 依赖单点数据库，写入放大严重，压测时 QPS 到 3000 就开始超时。",
  "队列解耦\n用消息队列把写入异步化，压测 QPS 12000 无超时，但要接受最终一致。",
];
const Q = "为什么觉得方案A不行，后来怎么变的";
const ITEMS = [
  { index: 1, line: "［想法］为什么觉得方案A不行（2026-08-03）", fallbackLine: "［想法］（2026-08-03）" },
  { index: 2, line: "［想法］队列解耦（2026-08-26）", fallbackLine: "［想法］（2026-08-26）" },
];

describe("R318 C2：裸〔原文查看〕判定", () => {
  it("只剩收口通知（含角标）为真；带任何实义句为假；无通知为假", () => {
    expect(isBareVerbatimNotice(VERBATIM_REDIRECT_NOTICE)).toBe(true);
    expect(isBareVerbatimNotice(`${VERBATIM_REDIRECT_NOTICE}[1][2]`)).toBe(true);
    expect(isBareVerbatimNotice(`  ${AGGREGATE_VERBATIM_GUIDE}\n`)).toBe(true);
    expect(isBareVerbatimNotice(`已找到两条相关记录。${VERBATIM_REDIRECT_NOTICE}`)).toBe(false);
    expect(isBareVerbatimNotice("方案A 因写入放大被放弃 [1]")).toBe(false);
    expect(isBareVerbatimNotice("")).toBe(false);
  });
  it("R317 复现形态：整答照抄两条笔记 → 出口收成裸通知（R314 P1-1 的墙折叠接不到）", () => {
    const answer = `${UNITS[0].split("\n")[1]} [1]\n${UNITS[1].split("\n")[1]} [2]`;
    const fin = finalizeAskAnswer(answer, { dataText: UNITS.join("\n"), dataUnits: UNITS, question: Q, verbatimExempt: Q, tier: AGGREGATE_TIER });
    expect(isBareVerbatimNotice(fin.answer)).toBe(true);
    expect(collapsePlaceholderWall(fin.answer)).toBe(fin.answer);
  });
});

describe("R318 C2：结构化「概括 + 指引」", () => {
  it("标题 ≥LCS8 与资料面重叠 → 退化为分类 + 日期；短标题保留；角标逐条对应", () => {
    const guide = aggregateGuideAnswer(ITEMS, UNITS);
    expect(guide.startsWith(AGGREGATE_GUIDE_LEAD)).toBe(true);
    expect(guide).toContain("- ［想法］（2026-08-03） [1]");
    expect(guide).not.toContain("为什么觉得方案A不行");
    expect(guide).toContain("- ［想法］队列解耦（2026-08-26） [2]");
    expect(guide).not.toContain(VERBATIM_SPAN_PLACEHOLDER);
    expect(guide).not.toContain(AGGREGATE_VERBATIM_GUIDE);
  });
  it("正文再过一次同一安全出口不改写（领句不含读者指令动词）", () => {
    const guide = aggregateGuideAnswer(ITEMS, UNITS);
    const fin = finalizeAskAnswer(guide, { dataText: UNITS.join("\n"), dataUnits: UNITS, question: Q, verbatimExempt: Q, tier: AGGREGATE_TIER, execDangerSegments: [] });
    expect(fin.changed).toBe(false);
    expect(fin.isolated).toBe(false);
    expect(fin.answer).toBe(guide);
  });
  it("出口附系统指引后，SSE 终态复核（closeAggregateVerbatim）零改写", () => {
    const out = `${aggregateGuideAnswer(ITEMS, UNITS)}\n${AGGREGATE_VERBATIM_GUIDE}`;
    const again = closeAggregateVerbatim(out, UNITS);
    expect(again.count).toBe(0);
    expect(again.answer).toBe(out);
  });
  it("零条引用 → 空串（调用方保留裸通知）", () => {
    expect(aggregateGuideAnswer([], UNITS)).toBe("");
  });
  it("标题里带资料原文整行也不外泄（fail-closed 到 fallbackLine）", () => {
    const items = [{ index: 1, line: `［资料］${UNITS[0].split("\n")[1]}（2026-08-03）`, fallbackLine: "［资料］（2026-08-03）" }];
    const guide = aggregateGuideAnswer(items, UNITS);
    expect(guide).toContain("- ［资料］（2026-08-03） [1]");
    expect(guide).not.toContain("QPS");
  });

  it("记账笔记：结构化行与来源重叠时退回「分类 + 底账金额 + 日期」，金额不丢（finance36 兼职收入同型）", () => {
    const n = {
      id: "n1", user_id: "u1", source: "web", raw_type: "text",
      content: "兼职收入 1200 元", url: null, url_title: null, url_summary: null, url_titles: null,
      category: "income", tags: "[]", title: "兼职收入 1200 元", thread_id: null, is_sensitive: 0, content_enc: null,
      todo_due: null, todo_done: 0, done_at: null, amount: 1200, currency: "CNY", meta: null,
      created_at: "2026-09-04 10:00:00", updated_at: "2026-09-04 10:00:00", deleted_at: null,
    } as NoteRow;
    expect(ledgerAmountText(n)).toBe("¥1200");
    const item = aggregateGuideItem(n, 1);
    expect(item.line).toBe("［收入］兼职收入 1200 元（2026-09-04）");
    expect(item.fallbackLine).toBe("［收入］（¥1200）（2026-09-04）");
    const guide = aggregateGuideAnswer([item], ["兼职收入 1200 元，周末家教两次"]);
    expect(guide).toContain("- ［收入］（¥1200）（2026-09-04） [1]");
    expect(guide).not.toContain("家教");
    expect(ledgerAmountText({ ...n, is_sensitive: 1 })).toBeNull();
    expect(ledgerAmountText({ ...n, category: "idea" })).toBeNull();
    expect(aggregateGuideItem({ ...n, category: "idea", title: "周末家教" }, 2).fallbackLine).toBe("［想法］（2026-09-04）");
  });
});
