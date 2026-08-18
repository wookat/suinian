// R186（audit-r185 P1-1）：代词追问的意图判定。
// 生产实录：历史「HHKB 键盘什么时候买的」后追问「它花了多少钱」，
// financeAggIntent 剥词后残留「它」<2 字被判成全账 exact 聚合，答成收支汇总。
import { describe, it, expect } from "vitest";
import { financeAggIntent, financeTopicTerms, ASK_PRONOUN_REF_RE } from "../src/ask";

describe("ASK_PRONOUN_REF_RE (R186 P1)", () => {
  it("matches entity-referring pronouns/demonstratives", () => {
    for (const q of [
      "它花了多少钱",
      "那条笔记说了什么",
      "这笔支出是什么时候的",
      "那次花了多少钱",
      "这个多少钱",
      "那个后来怎么样了",
      "这本讲什么",
    ]) {
      expect(ASK_PRONOUN_REF_RE.test(q), q).toBe(true);
    }
  });

  it("does not match time qualifiers or 其它", () => {
    for (const q of [
      "这个月花了多少钱",
      "那个月一共支出多少",
      "这个星期记了什么",
      "这个周末去哪了",
      "那个礼拜的支出",
      "其它支出一共多少",
      "上个月收支怎么样",
    ]) {
      expect(ASK_PRONOUN_REF_RE.test(q), q).toBe(false);
    }
  });
});

describe("financeAggIntent pronoun guard (R186 P1)", () => {
  it("「它花了多少钱」asks a specific item's price, never the whole-ledger exact aggregate", () => {
    expect(financeAggIntent("它花了多少钱")).toBeNull();
    expect(financeAggIntent("这个花了多少钱")).toBeNull();
    expect(financeAggIntent("那次花了多少钱")).toBeNull();
  });

  it("strong aggregate wording with a pronoun still falls through to normal recall", () => {
    expect(financeAggIntent("它一共花了多少钱")).toBeNull();
    expect(financeAggIntent("那笔一共多少钱")).toBeNull();
  });

  it("time-qualified aggregates keep the exact route (q67 non-regression)", () => {
    expect(financeAggIntent("这个月一共花了多少钱")).toBe("exact");
    expect(financeAggIntent("这个月花了多少钱")).toBe("exact");
    expect(financeAggIntent("一共花了多少钱")).toBe("exact");
  });

  it("pronoun questions never yield subset topic terms (rewrite provides the topic)", () => {
    expect(financeTopicTerms("它一共花了多少钱")).toBeNull();
  });

  it("rewritten self-contained question routes to the topic subset", () => {
    expect(financeTopicTerms("机械键盘一共花了多少钱")).toEqual(["机械键盘"]);
  });
});
