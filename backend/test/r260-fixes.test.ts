import { describe, it, expect } from "vitest";
import { financeListFollowUpIntent, financeAggAnswerTerms, BASIS_INTENT_RE, rerankBasisCandidates } from "../src/ask";

// R260 P1-1（audit-r259）：话题切换追问的关键词继承撤销矩阵。
// 上一轮是关键词子集合计（「今年买书花了多少」→「按关键词「买书」精确匹配…
// 共 1 笔支出」），本轮追问显式点名的方向在上一轮子集里为零笔时（问收入），
// 说明用户已切出该话题——撤销关键词继承；同话题裸追问与同方向追问继承不变。

const SUBSET_EXPENSE =
  "按关键词「买书」精确匹配（标题/正文/标签），今年共 1 笔支出：\n- 《深度工作》（¥52.00，2026-01-12）[1]\n\n以上为数据库精确统计（关键词匹配口径，金额口径与周报/月报一致，不含已删除笔记）。";
const SUBSET_BOTH =
  "按关键词「咖啡」精确匹配（标题/正文/标签），今年共 3 笔支出、1 笔收入：\n- …\n\n以上为数据库精确统计（关键词匹配口径，金额口径与周报/月报一致，不含已删除笔记）。";
const PLAIN_AGG = "这个月你一共花了 ¥711（共 2 笔支出）。\n\n以上为精确统计，口径与周报/月报一致。";

describe("话题切换追问撤销关键词继承 (R260 P1-1)", () => {
  it("支出子集合计后显式问收入：识别为收入追问但不继承关键词", () => {
    const dir = financeListFollowUpIntent("本月收入有哪几笔？", SUBSET_EXPENSE);
    expect(dir).toBe("income");
    expect(financeAggAnswerTerms(SUBSET_EXPENSE, dir)).toBeNull();
    const dir2 = financeListFollowUpIntent("有哪些进账？", SUBSET_EXPENSE);
    expect(dir2).toBe("income");
    expect(financeAggAnswerTerms(SUBSET_EXPENSE, dir2)).toBeNull();
  });

  it("同话题裸追问继续继承关键词（R258 P2-3 不回退）", () => {
    const dir = financeListFollowUpIntent("分别是哪几笔？", SUBSET_EXPENSE);
    expect(dir).toBe("both");
    expect(financeAggAnswerTerms(SUBSET_EXPENSE, dir)).toEqual(["买书"]);
  });

  it("同方向显式追问继续继承（支出合计后问支出）", () => {
    const dir = financeListFollowUpIntent("支出有哪几笔？", SUBSET_EXPENSE);
    expect(dir).toBe("expense");
    expect(financeAggAnswerTerms(SUBSET_EXPENSE, dir)).toEqual(["买书"]);
  });

  it("子集里本就有收入时问收入：合法追问继续继承", () => {
    const dir = financeListFollowUpIntent("收入有哪几笔？", SUBSET_BOTH);
    expect(dir).toBe("income");
    expect(financeAggAnswerTerms(SUBSET_BOTH, dir)).toEqual(["咖啡"]);
  });

  it("非子集（全账）合计答案不受影响：从不继承关键词", () => {
    expect(financeAggAnswerTerms(PLAIN_AGG, "income")).toBeNull();
    expect(financeAggAnswerTerms(PLAIN_AGG, "both")).toBeNull();
  });

  it("未传方向（旧调用形态）保持 R258 行为", () => {
    expect(financeAggAnswerTerms(SUBSET_EXPENSE)).toEqual(["买书"]);
  });
});

// R260 P2/q31（audit-r259 改判）：依据类问题候选重排。
// q31 实测：cafe2 语义 0.72 在 20 条候选里排第 9，被零分关键词/图谱补位片段
// 隔开，模型只从头部引用 → 十跑 5/10。重排后强命中按分数聚到头部。
describe("依据类问题强命中重排 (R260 P2/q31)", () => {
  const N = (id: string) => ({ id });
  const score = new Map([
    ["nz18", 0.84],
    ["cafe3", 0.87],
    ["cafe1", 0.75],
    ["pod3", 0.56],
    ["cafe2", 0.72],
  ]);
  it("强命中按语义分数聚到头部，弱/零分片段保持相对顺序在后", () => {
    const notes = ["nz18", "cafe3", "cafe1", "pod3", "kw1", "kw2", "cafe2", "g1", "g2"].map(N);
    const out = rerankBasisCandidates(notes, score).map((n) => n.id);
    expect(out).toEqual(["cafe3", "nz18", "cafe1", "cafe2", "pod3", "kw1", "kw2", "g1", "g2"]);
  });
  it("纯重排不增删：集合不变", () => {
    const notes = ["a", "b", "cafe2"].map(N);
    const out = rerankBasisCandidates(notes, score);
    expect(new Set(out.map((n) => n.id))).toEqual(new Set(["a", "b", "cafe2"]));
  });
  it("强命中不足 2 条或全为强命中时原序返回（不动其他问题族的既有顺序）", () => {
    const notes = ["kw1", "cafe2", "kw2"].map(N);
    expect(rerankBasisCandidates(notes, score).map((n) => n.id)).toEqual(["kw1", "cafe2", "kw2"]);
    const allStrong = ["nz18", "cafe3"].map(N);
    expect(rerankBasisCandidates(allStrong, score).map((n) => n.id)).toEqual(["nz18", "cafe3"]);
  });
  it("依据类意图正则覆盖为什么/依据/理由/原因/根据，不误伤普通问题", () => {
    for (const q of ["我为什么想做周末快闪店？依据是哪几条笔记", "放弃咖啡馆的理由", "涨价的原因", "根据哪些笔记"]) {
      expect(BASIS_INTENT_RE.test(q)).toBe(true);
    }
    for (const q of ["上个月花了多少钱", "最近记了什么", "播客进展如何"]) {
      expect(BASIS_INTENT_RE.test(q)).toBe(false);
    }
  });
});
