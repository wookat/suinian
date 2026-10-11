// R110: finance-aggregate intent coverage + fail-closed routing (R109 P1),
// and user-timezone todo due/reminder parsing (R109 P2-2).
import { describe, expect, it } from "vitest";
import { isFinanceAggQuestion, financeAggIntent, buildFinanceFailClosedAnswer, buildFinanceAggAnswer } from "../src/ask";
import { financeStats } from "../src/reports";
import { todoDueEpochMs, todoReminderEpochMs } from "../src/push";
import type { NoteRow } from "../src/types";

const note = (over: Partial<NoteRow>): NoteRow =>
  ({
    id: "n1",
    user_id: "u1",
    source: "web",
    raw_type: "text",
    content: "x",
    url: null,
    category: "expense",
    tags: "[]",
    title: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: 0,
    done_at: null,
    amount: 100,
    currency: "CNY",
    meta: null,
    created_at: "2026-08-01 03:00:00",
    updated_at: "2026-08-01 03:00:00",
    deleted_at: null,
    content_enc: null,
    ...over,
  }) as unknown as NoteRow;

describe("financeAggIntent: exact aggregate wording variants (R109 audit badcases)", () => {
  const exact = [
    "上个月结余多少钱",
    "上个月一共结余多少",
    "上个月结余多少",
    "本月收支结余怎么样，一共多少",
    "这个月收支情况如何",
    "最近30天收支怎么样",
    "今年总共赚了多少",
    "这个月挣了多少钱",
    "上个月开销总额是多少",
    "8月一共花了多少钱",
  ];
  for (const q of exact) {
    it(`exact: ${q}`, () => {
      expect(isFinanceAggQuestion(q)).toBe(true);
      expect(financeAggIntent(q)).toBe("exact");
    });
  }
});

describe("financeAggIntent: fail-closed on qualified aggregates (no LLM mental math)", () => {
  const failClosed = [
    "这个月咖啡一共花了多少",
    "上个月打车总共花了多少钱",
    "日元和人民币的支出加起来一共是多少",
    "给猫花的钱合计有多少",
  ];
  for (const q of failClosed) {
    it(`fail-closed: ${q}`, () => expect(financeAggIntent(q)).toBe("fail_closed"));
  }
});

describe("financeAggIntent: single-item / non-finance questions go through normal ask", () => {
  const normal = ["买咖啡花了多少钱", "机械键盘多少钱买的", "李医生的电话是多少", "8月有什么值得回顾的想法", "上个月给猫打疫苗花了多少钱"];
  for (const q of normal) {
    it(`normal: ${q}`, () => expect(financeAggIntent(q)).toBe(null));
  }
});

describe("buildFinanceFailClosedAnswer", () => {
  it("refuses the arithmetic and shows exact per-currency stats instead", () => {
    const stats = financeStats([note({ amount: 100 }), note({ amount: 2000, currency: "JPY" })]);
    const md = buildFinanceFailClosedAnswer(stats, "这个月");
    expect(md).toContain("不做心算合计");
    expect(md).toContain(buildFinanceAggAnswer(stats, "这个月"));
    expect(md).toContain("CNY");
    expect(md).toContain("JPY");
  });
});

describe("todo due/reminder times follow the user timezone (R109 P2-2)", () => {
  it("bare dates: 09:00 due / 08:00 reminder in the user's tz", () => {
    expect(todoDueEpochMs("2026-08-08", "America/New_York")).toBe(Date.parse("2026-08-08T09:00:00-04:00"));
    expect(todoReminderEpochMs("2026-08-08", "America/New_York")).toBe(Date.parse("2026-08-08T08:00:00-04:00"));
    expect(todoDueEpochMs("2026-08-08", "Asia/Tokyo")).toBe(Date.parse("2026-08-08T09:00:00+09:00"));
  });
  it("legacy offset-less datetimes are Asia/Shanghai regardless of tz (same instant the API serves)", () => {
    // normalizeStoredTodoDue hands every client "…T14:30:00+08:00" for this row;
    // the reminder must target that displayed instant, not a user-local reading.
    expect(todoDueEpochMs("2026-08-08T14:30", "America/New_York")).toBe(Date.parse("2026-08-08T14:30:00+08:00"));
    expect(todoReminderEpochMs("2026-08-08T14:30", "America/New_York")).toBe(Date.parse("2026-08-08T14:00:00+08:00"));
    expect(todoDueEpochMs("2026-08-08T14:30:55", "UTC")).toBe(Date.parse("2026-08-08T14:30:55+08:00"));
    expect(todoDueEpochMs("2026-08-08 14:30", "America/New_York")).toBe(Date.parse("2026-08-08T14:30:00+08:00"));
  });
  it("explicit offsets are respected regardless of tz", () => {
    expect(todoDueEpochMs("2026-08-08T14:30:00+08:00", "America/New_York")).toBe(Date.parse("2026-08-08T14:30:00+08:00"));
  });
  it("defaults to Asia/Shanghai (legacy behaviour) and survives invalid tz", () => {
    expect(todoDueEpochMs("2026-08-08")).toBe(Date.parse("2026-08-08T09:00:00+08:00"));
    expect(todoDueEpochMs("2026-08-08", "Not/AZone")).toBe(Date.parse("2026-08-08T09:00:00+08:00"));
  });
});
