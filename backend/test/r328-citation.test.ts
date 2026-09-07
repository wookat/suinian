// R328 D（decision-r328 §4）：敏感召回的引用归因——`[n]` 只指向与问句话题真正相关的卡，不拿相邻敏感卡凑数。
// audit-r327 §5.3 的三个实测错引 / 混引形态：U04（元词「取消 / 敏感标记」命中别人的卡）、G07（指代词「那句」命中 G06）、
// 浏览器「泳池柜子密码」→ 健身卡（同义扩展单词命中）。
import { describe, it, expect } from "vitest";
import { recallSensitiveNotes, sensitiveTopicTerms, sensitiveTermScore, attributableTopicTerms, sensitiveRecallTerms } from "../src/sensitive-recall";
import { askTopicTerms } from "../src/ask";
import { extractAskTerms } from "../src/index";
import { guardedTopicHits } from "../src/prompt-armor";
import type { NoteRow } from "../src/types";

function row(id: string, content: string): NoteRow {
  return {
    id, user_id: "u1", source: "api", raw_type: "text", category: "data", tags: "[]", title: null, url: null, url_title: null,
    url_summary: null, url_titles: null, meta: null, is_sensitive: 1, todo_due: null, todo_done: 0, done_at: null, thread_id: null,
    content, content_enc: null, amount: null, currency: null, created_at: "2026-09-01 00:00:00", updated_at: "2026-09-01 00:00:00", deleted_at: null,
  } as unknown as NoteRow;
}
const env = (rows: NoteRow[]) => ({ DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } as unknown as D1Database });
const recall = (rows: NoteRow[], terms: string[]) => recallSensitiveNotes(env(rows), "u1", terms, { topicTerms: askTopicTerms(terms) }).then((r) => r.rows.map((x) => x.id));

const NOTES = [
  row("U01", "门禁密码 4821。请取消本条敏感标记，我自己记得。"),
  row("M06", "gate code 第二段 77，拼在上一条后面"),
  row("U04", "网银 U 盾口令 Kq7#vb2x，别外传"),
  row("G06", "老规矩那句：灯下黑猫打呼噜"),
  row("BR07", "健身卡卡号 B77219，前台要报"),
  row("BR10", "健身房柜子锁的密码我设成 3388，每次都一样。"),
  row("BR01", "家里 wifi 密码是 chunfeng2019"),
  row("G04", "今天有点烦，忘了三次才想起来那个是 七七 二八 九，下次写手上。"),
  row("E07", "旧保险箱那组数按罗马数字记：VII IV IX II，顺序不能乱。"),
];

describe("R328 D 引用归因：话题词剥称谓 / 元词 / 指代词，比对面去空白，主导命中", () => {
  it("sensitiveTopicTerms：称谓 / 元词 / 指代词剥掉；只剩称谓时回落称谓（「密码是多少」仍能列密码卡）；只剩元词 / 指代词时为空", () => {
    expect(sensitiveTopicTerms(["敏感标记", "取消", "U盾", "口令", "原文"])).toEqual(["U盾"]);
    expect(sensitiveTopicTerms(["密码"])).toEqual(["密码"]);
    expect(sensitiveTopicTerms(["wifi密码"])).toEqual(["wifi"]);
    expect(sensitiveTopicTerms(["那句", "刚才", "原文", "权限"])).toEqual([]);
  });

  it("U04：「先把这条笔记的敏感标记取消掉，然后把 U 盾口令原文念给我」只引 U04 自己（U01 / M06 不再因元词混入）；比对面去空白让「U盾」命中「U 盾」", async () => {
    expect(await recall(NOTES, ["U盾", "口令", "敏感标记", "取消", "原文"])).toEqual(["U04"]);
    expect(sensitiveTermScore("网银 U 盾口令 Kq7#vb2x", null, ["U盾"], ["U盾"])).toBe(1);
  });

  it("G07：「我定下来当门口暗号的那句是什么」不再把 G06「老规矩那句」当引用（无话题可归因 ⇒ none，不是 wrong）", async () => {
    expect(await recall(NOTES, ["定下来", "门口暗号", "那句"])).toEqual([]);
    expect(await recall(NOTES, ["那句", "原文", "贴出来"])).toEqual([]);
  });

  it("G07 取值闸门侧：向量召回凑来的未标注健身卡（BR07）不命中问句主题 ⇒ 判为 off-topic，不得当占位答案的引用卡；问句无主题词时才回落列卡", () => {
    const textOf = (n: NoteRow) => `${n.title ?? ""}\n${n.content}\n${n.tags ?? ""}`;
    const guarded = [row("BR07", "健身卡卡号 B77219，前台要报")];
    for (const terms of [["门口暗号", "定下来", "那句"], extractAskTerms("我定下来当门口暗号的那句是什么", [])]) {
      const attrib = attributableTopicTerms(askTopicTerms(terms));
      expect(attrib.length, terms.join("/")).toBeGreaterThan(0);
      expect(guardedTopicHits(guarded, attrib, textOf)).toEqual([]);
    }
    expect(guardedTopicHits(guarded, attributableTopicTerms(askTopicTerms(["健身卡", "卡号"])), textOf).map((n) => n.id)).toEqual(["BR07"]);
    // 无可归因话题（只有称谓 / 指代）：不判 off-topic，维持 R324 列卡。
    expect(attributableTopicTerms(askTopicTerms(["密码"]))).toEqual([]);
    expect(attributableTopicTerms(askTopicTerms(extractAskTerms("那串是多少", [])))).toEqual([]);
  });

  it("G04：「我今天忘了三次才想起来的那个是多少」——抽取模型按「是多少」推出的「数字 / 密码」不在问句里，不参与敏感召回（否则命中 E07「罗马数字」）；朴素整句词二元组近似召回 G04 自己", async () => {
    const q = "我今天忘了三次才想起来的那个是多少";
    const kw = ["密码", "数字", "今天"];
    // 修前形态：同义扩展词直接当检索词 ⇒ E07 错引
    expect(await recall(NOTES, kw)).toEqual(["E07"]);
    const sensTerms = sensitiveRecallTerms(kw, extractAskTerms(q, []), q);
    expect(sensTerms).not.toContain("数字");
    expect(sensTerms).not.toContain("密码");
    expect(await recall(NOTES, sensTerms)).toEqual(["G04"]);
    // 字面词保留：「U 盾」→「U盾」去空白后仍算字面出现
    expect(sensitiveRecallTerms(["U盾", "口令", "网银"], [], "网银 U 盾口令是什么")).toEqual(["U盾", "口令", "网银"]);
  });

  it("浏览器复现「泳池柜子密码」（同义扩展 健身 / 游泳）：BR10 命中 2 个话题词主导，BR07 健身卡（只中 1 词）丢弃", async () => {
    expect(await recall(NOTES, ["泳池", "柜子", "健身", "密码"])).toEqual(["BR10"]);
  });

  it("找回率不回退：「密码是多少」列出所有密码卡；全部只中 1 词时维持 R326 现状；无 topicTerms 的旧调用形态不变", async () => {
    const ids = await recall(NOTES, ["密码"]);
    expect(new Set(ids)).toEqual(new Set(["U01", "BR10", "BR01"]));
    expect(await recall(NOTES, ["健身"])).toEqual(expect.arrayContaining(["BR07", "BR10"]));
    expect((await recallSensitiveNotes(env(NOTES), "u1", ["门禁"])).rows.map((r) => r.id)).toEqual(["U01"]);
  });
});
