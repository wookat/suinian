import { describe, it, expect } from "vitest";
import {
  financeExtremeIntent,
  financeExtremeTopicTerms,
  buildFinanceExtremeAnswer,
} from "../src/ask";
import { escapeLike, likeContains, tagLikePattern } from "../src/index";
import type { NoteRow } from "../src/types";

function row(over: Partial<NoteRow>): NoteRow {
  return {
    id: "n1",
    user_id: "u1",
    content: "内容",
    title: null,
    category: "expense",
    tags: null,
    source: "api",
    created_at: "2026-04-06 04:00:00",
    updated_at: "2026-04-06 04:00:00",
    deleted_at: null,
    is_sensitive: 0,
    amount: 100,
    currency: "CNY",
    ...over,
  } as NoteRow;
}

// ---- P1-2 序数金额提问走确定性 SQL 排名（audit-r181）----

describe("financeExtremeIntent ordinal (R182 P1-2)", () => {
  it("routes 第二贵 to max rank 2", () => {
    expect(financeExtremeIntent("我买过第二贵的东西是什么")).toEqual({ kind: "max", direction: "expense", rank: 2 });
    expect(financeExtremeIntent("第二贵的一笔支出")).toEqual({ kind: "max", direction: "expense", rank: 2 });
  });

  it("routes 排名第二 to max rank 2 (默认从大到小)", () => {
    expect(financeExtremeIntent("支出排名第二的是哪笔")).toEqual({ kind: "max", direction: "expense", rank: 2 });
    expect(financeExtremeIntent("金额排行第三的支出")).toEqual({ kind: "max", direction: "expense", rank: 3 });
  });

  it("routes 倒数第二 to min rank 2 (倒数翻转方向)", () => {
    expect(financeExtremeIntent("支出里倒数第二的是哪笔")).toEqual({ kind: "min", direction: "expense", rank: 2 });
    expect(financeExtremeIntent("花费排名倒数第二的是什么")).toEqual({ kind: "min", direction: "expense", rank: 2 });
  });

  it("倒数第二贵 = 第二便宜 (min rank 2)", () => {
    expect(financeExtremeIntent("倒数第二贵的一笔支出")).toEqual({ kind: "min", direction: "expense", rank: 2, reversedAdj: "贵" });
  });

  it("routes 第二便宜 to min rank 2", () => {
    expect(financeExtremeIntent("第二便宜的一笔支出")).toEqual({ kind: "min", direction: "expense", rank: 2 });
  });

  it("routes ordinal income questions", () => {
    expect(financeExtremeIntent("第二高的一笔收入是多少")).toEqual({ kind: "max", direction: "income", rank: 2 });
  });

  it("supports arabic numerals", () => {
    expect(financeExtremeIntent("支出排名第3的是哪笔")).toEqual({ kind: "max", direction: "expense", rank: 3 });
  });

  it("时间序数不收口：第二次买/第二天不是金额排名", () => {
    expect(financeExtremeIntent("我第二次买键盘花了多少钱")).toBeNull();
    expect(financeExtremeIntent("旅行第二天花了多少钱")).toBeNull();
  });

  it("无财务语境的序数不收口", () => {
    expect(financeExtremeIntent("排名第二的山是哪座")).toBeNull();
    expect(financeExtremeIntent("第二高的山是什么")).toBeNull();
  });

  it("keeps topic qualifiers with ordinal wording", () => {
    expect(financeExtremeTopicTerms("金额倒数第二的一笔支出是哪笔")).toBeNull();
    expect(financeExtremeTopicTerms("我买过的键盘里第二贵的是哪一把")).toEqual(["键盘"]);
    expect(financeExtremeTopicTerms("键盘里排名第二贵的是哪把")).toEqual(["键盘"]);
    expect(financeExtremeTopicTerms("第二贵的一笔支出")).toBeNull();
  });
});

describe("buildFinanceExtremeAnswer with rank (R182 P1-2)", () => {
  it("labels the rank in the answer and caliber footnote", () => {
    const a = buildFinanceExtremeAnswer(
      { kind: "max", direction: "expense", rank: 2 },
      [row({ amount: 3200, content: "买了台显示器 3200 元" })],
      0,
      null
    );
    expect(a).toContain("金额第 2 大");
    expect(a).toContain("¥3200");
    expect(a).toContain("排序取第 2 名");
    expect(a).toContain("不含已删除笔记");
  });

  it("states honestly when there are fewer rows than the rank", () => {
    const a = buildFinanceExtremeAnswer(
      { kind: "max", direction: "expense", rank: 3 },
      [],
      0,
      null,
      null,
      0,
      [{ currency: "CNY", count: 2 }]
    );
    expect(a).toContain("不足 3 笔");
    expect(a).toContain("仅 2 笔");
    expect(a).not.toContain("¥");
  });

  it("rank 1 keeps the existing extreme wording", () => {
    const a = buildFinanceExtremeAnswer(
      { kind: "max", direction: "expense", rank: 1 },
      [row({ amount: 8999 })],
      0,
      null
    );
    expect(a).toContain("金额最大");
    expect(a).not.toContain("第 1 大");
  });
});

// ---- P2-1 搜索 LIKE 通配符转义：搜什么就是什么（audit-r181）----

describe("LIKE literal semantics (R182 P2-1)", () => {
  it("escapes % _ \\ so they match literally", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
    expect(likeContains("_")).toBe("%\\_%");
    expect(likeContains("%")).toBe("%\\%%");
    expect(likeContains("note_1.md")).toBe("%note\\_1.md%");
  });

  it("plain terms are unchanged", () => {
    expect(likeContains("键盘")).toBe("%键盘%");
    expect(tagLikePattern("读书")).toBe('%"读书"%');
  });

  it("byte cap never leaves a dangling escape backslash", () => {
    const p = likeContains("a".repeat(44) + "%%%");
    expect(p.startsWith("%")).toBe(true);
    expect(p.endsWith("%")).toBe(true);
    // strip the surrounding wildcards; trailing backslashes must be paired
    const inner = p.slice(1, -1);
    const trail = inner.match(/\\+$/);
    expect((trail?.[0].length ?? 0) % 2).toBe(0);
  });

  it("escapes tag patterns too", () => {
    expect(tagLikePattern("a_b")).toBe('%"a\\_b"%');
  });
});
