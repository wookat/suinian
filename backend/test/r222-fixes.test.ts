import { describe, it, expect } from "vitest";
import { topicSummaryIntent, topicSummaryTopN, buildTopicSummaryAnswer } from "../src/ask";
import { fixFinanceDirection } from "../src/triage";
import type { TriageResult } from "../src/types";
import {
  overviewStatLine,
  sanitizeNarrative,
  sanitizeBareUrls,
  todoSection,
  type ReportNumbers,
  type TodoStats,
} from "../src/reports";

function nums(p?: Partial<ReportNumbers>): ReportNumbers {
  return {
    total: 30,
    counts: new Map([
      ["idea", 14],
      ["data", 6],
      ["todo", 5],
      ["expense", 4],
      ["transfer", 1],
    ]),
    sensitive: 2,
    todoCreated: 5,
    todoDone: 3,
    ...p,
  };
}

describe("R222 P1-2 report numbers are template-injected, never LLM-transcribed", () => {
  it("overviewStatLine renders the exact SQL-sourced counts", () => {
    const line = overviewStatLine("本周", nums());
    expect(line).toBe(
      "本周共记录 30 条（想法 14 条、资料 6 条、待办 5 条、支出 4 条、资金往来 1 条；含 2 条敏感记录，仅计数不展示内容）。"
    );
  });

  it("overviewStatLine omits the sensitive clause when none", () => {
    const line = overviewStatLine("本月", nums({ sensitive: 0 }));
    expect(line).toContain("本月共记录 30 条");
    expect(line).not.toContain("敏感");
  });

  it("rewrites transcription errors back to SQL source values (audit-r221 weekly case)", () => {
    // 模型抄错：资料 5（应 6）、资金往来 2（应 1）
    const t = sanitizeNarrative("本周共记录 30 条，其中资料 5 条、资金往来 2 条。", "本周", nums());
    expect(t).toContain("资料 6 条");
    expect(t).toContain("资金往来 1 条");
    expect(t).not.toContain("资料 5 条");
  });

  it("rewrites transcription errors back to SQL source values (audit-r221 monthly case)", () => {
    // 模型抄错：总数 58（应 59）、想法 13（应 14）
    const n = nums({ total: 59 });
    const t = sanitizeNarrative("本月共记录 58 条，想法 13 条占大头。", "本月", n);
    expect(t).toContain("共记录 59 条");
    expect(t).toContain("想法 14 条");
  });

  it("rewrites todo counts to the SQL todo stats", () => {
    const t = sanitizeNarrative("本周新增待办 6 条，共完成 2 条。", "本周", nums());
    expect(t).toContain("新增待办 5 条");
    expect(t).toContain("共完成 3 条");
  });

  it("strips a duplicated H1 title and overview heading from the LLM output", () => {
    const t = sanitizeNarrative(
      "# 碎念周报（2026-08-10 ~ 2026-08-16）\n\n## 本周概览\n这周你主要在忙搬家。\n\n## 主要在想什么\n围绕新家布置。",
      "本周",
      nums()
    );
    expect(t.startsWith("这周你主要在忙搬家。")).toBe(true);
    expect(t).toContain("## 主要在想什么");
  });

  it("drops program-owned 待办盘点/收支合计 sections the model emits anyway", () => {
    const t = sanitizeNarrative(
      "主线叙述。\n\n## 待办盘点\n新增待办 4 条。\n\n## 收支合计\n支出 ¥123。\n\n## 悬而未决\n还没定。",
      "本周",
      nums()
    );
    expect(t).not.toContain("## 待办盘点");
    expect(t).not.toContain("## 收支合计");
    expect(t).toContain("## 悬而未决");
  });

  it("todoSection uses the period unit (月报 no longer says 本周)", () => {
    const stats: TodoStats = { created: 2, createdDone: 1, doneInWeek: 1, openTitles: [], doneTitles: [] };
    expect(todoSection(stats, "本月")).toContain("本月新增待办 2 条");
    expect(todoSection(stats)).toContain("本周新增待办 2 条");
  });
});

describe("R222 P2-2 bare URL sanitization", () => {
  it("terminates a bare URL before Chinese punctuation and wraps it in <>", () => {
    const md = "看这篇 https://example.com/a/b，讲得不错";
    expect(sanitizeBareUrls(md)).toBe("看这篇 <https://example.com/a/b>，讲得不错");
  });

  it("strips trailing ASCII punctuation from the URL", () => {
    expect(sanitizeBareUrls("see https://example.com/x). next")).toBe("see <https://example.com/x>). next");
  });

  it("leaves existing markdown links and autolinks untouched", () => {
    const md = "[文章](https://example.com/a) 与 <https://example.com/b>";
    expect(sanitizeBareUrls(md)).toBe(md);
  });

  // R266 P0：叙述里非白名单外链改为剥除（回传通道收口），白名单域仍走 <> 包裹
  it("sanitizeNarrative strips non-allowlisted external links", () => {
    const t = sanitizeNarrative("你收藏了 https://example.com/read，值得回看。", "本周", nums());
    expect(t).not.toContain("example.com");
    expect(t).toContain("〔已移除外部链接〕");
  });

  it("sanitizeNarrative keeps allowlisted links wrapped", () => {
    const t = sanitizeNarrative("详见 https://suinian.zalize.com/notes，值得回看。", "本周", nums());
    expect(t).toContain("<https://suinian.zalize.com/notes>，");
  });
});

describe("R222 P3-4 topic summary questions (audit-r221 Q24)", () => {
  it("recognizes topic-summary questions", () => {
    expect(topicSummaryIntent("最近一个月最关注的三个主题")).toBe(true);
    expect(topicSummaryIntent("我最近主要在想什么")).toBe(true);
    expect(topicSummaryIntent("这个月的主题有哪些")).toBe(true);
    expect(topicSummaryIntent("这个月记了几笔支出")).toBe(false);
    expect(topicSummaryIntent("空气炸锅花了多少钱")).toBe(false);
  });

  it("parses top-N from the question with a default of 3", () => {
    expect(topicSummaryTopN("最近一个月最关注的三个主题")).toBe(3);
    expect(topicSummaryTopN("最关注的5个话题")).toBe(5);
    expect(topicSummaryTopN("我最近主要在想什么")).toBe(3);
  });

  it("answers with tag frequency counts, excluding sensitive notes' tags", () => {
    const rows = [
      { tags: JSON.stringify(["装修", "预算"]), is_sensitive: 0 },
      { tags: JSON.stringify(["装修"]), is_sensitive: 0 },
      { tags: JSON.stringify(["跑步"]), is_sensitive: 0 },
      { tags: JSON.stringify(["密码"]), is_sensitive: 1 },
    ];
    const a = buildTopicSummaryAnswer(rows, "最近一个月", 3);
    expect(a).toContain("1. 装修（2 条相关笔记）");
    expect(a).not.toContain("密码");
    expect(a).toContain("周报/月报");
  });

  it("falls back to a reports-page hint when no tags exist", () => {
    const a = buildTopicSummaryAnswer([], null, 3);
    expect(a).toContain("报告");
  });
});

describe("R222 P2-3 方向兑底与格短语修正 (audit-r221 生产复现)", () => {
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

  it("「给我爸买按摩仪 599」：模型判 expense 不被兑底翻成 income", () => {
    const fixed = fixFinanceDirection("给我爸买按摩仪 599", t("expense", { amount: 599, currency: "CNY" }));
    expect(fixed.category).toBe("expense");
  });

  it("「给我爸买按摩仪 599」：模型误判 income 被兑底纠回 expense", () => {
    const fixed = fixFinanceDirection("给我爸买按摩仪 599", t("income", { amount: 599, currency: "CNY" }));
    expect(fixed.category).toBe("expense");
  });

  it("「给我转/交」类钱进用户手里的语境仍是 income 侧，不误纠", () => {
    expect(fixFinanceDirection("学生给我交了补课费 300", t("income", { amount: 300 })).category).toBe("income");
    expect(fixFinanceDirection("朋友给我转了 200", t("income", { amount: 200 })).category).toBe("income");
  });

  it("「充话费 100」：方向兑底不干扰 expense 判定", () => {
    expect(fixFinanceDirection("充话费 100", t("expense", { amount: 100 })).category).toBe("expense");
  });
});
