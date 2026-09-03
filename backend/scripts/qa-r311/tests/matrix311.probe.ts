/**
 * R311 本地 11 态矩阵（收集型）：
 *  危险载体 = R307 145 + R309 70（分片族合并）+ R311 新造 44 纯语义载体
 *  × 11 判别器状态 × 3 问法（plain / verbatim / qinject=问句里带原文）× 3 复述形态（echo / tokens / lines）
 *  两套口径并列：
 *    leak.mjs「任意危险片段」（R310 口径，依赖 dangerTokens 的代码面词表）
 *    R311「任意原文行」：答案（NFKC 折叠面）含资料任一 ≥4 字整行且该行不在问句里 —— 对纯语义载荷
 *    dangerTokens 基本不认，用这个口径才能看见「摘要里夹带纯文字载荷」。
 *  善意 307 + 新造 42 × 11 态 × 2 问法：整答隔离率。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";

const chatComplete = vi.fn();
vi.mock("../../../src/ai", () => ({ chatComplete: (...args: unknown[]) => chatComplete(...args) }));

import {
  classifyDangerousCodeSegments,
  EXEC_CLASSIFY_SOFT_BUDGET_MS,
  EXEC_CLASSIFIER_FAIL_STREAK_OPEN,
  markExecClassifierHealthy,
  markExecClassifierUnavailable,
  execClassifierRecentlyUnavailable,
} from "../../../src/answer-guard";
import {
  finalizeAskAnswer,
  splitSegmentsFenceAware,
  execClassifierGateReason,
  execCodeSurfaceTraceReason,
  execDegradedTraceReason,
  execCombinationGateReason,
  globalExecDangerReason,
  judgeSurfaceText,
  broadFoldReason,
  fragmentExecNoteIds,
} from "../../../src/prompt-armor";
import { CARRIERS as ALL } from "../../qa-r309/carriers";
import { BENIGN } from "../../qa-r309/benign";
// @ts-expect-error 纯 JS 口径模块
import { leakedFragments, dangerTokens, norm } from "../../qa-r310/leak.mjs";
// @ts-expect-error 纯 JS 语料模块
import { NEW311, BENIGN311 } from "../new-carriers.mjs";

mkdirSync("out", { recursive: true });

const FRAG_ID_RE = /^([A-Z]+\d+)[a-z]$/;
const fragGroups = new Map<string, typeof ALL>();
for (const c of ALL) {
  const m = FRAG_ID_RE.exec(c.id);
  if (m) fragGroups.set(m[1], [...(fragGroups.get(m[1]) ?? []), c]);
}
type Unit = { id: string; cat: "reg" | "new" | "r311"; family: string; units: string[] };
const CARRIERS: Unit[] = [
  ...ALL.filter((c) => !FRAG_ID_RE.test(c.id)).map((c) => ({ id: c.id, cat: c.cat as "reg" | "new", family: c.family, units: [c.text] })),
  ...[...fragGroups].map(([g, cs]) => ({ id: g, cat: cs[0].cat as "reg" | "new", family: cs[0].family, units: cs.map((c) => c.text) })),
  ...(NEW311 as Array<{ id: string; family: string; text: string }>).map((c) => ({ id: c.id, cat: "r311" as const, family: c.family, units: [c.text] })),
];

const env = {} as never;
type State = "hit" | "empty" | "oob" | "slow" | "error" | "timeout" | "truncated" | "missing" | "nonjson" | "unavailable" | "window";
const STATES: State[] = ["hit", "empty", "oob", "slow", "error", "timeout", "truncated", "missing", "nonjson", "unavailable", "window"];
const SLOW_SOFT_MS = 30;

function armStub(state: State, segCount: number): void {
  chatComplete.mockReset();
  switch (state) {
    case "hit": chatComplete.mockResolvedValue(JSON.stringify(Array.from({ length: segCount }, (_, i) => i + 1))); break;
    case "empty": chatComplete.mockResolvedValue("[]"); break;
    case "oob": chatComplete.mockResolvedValue(`[1, ${segCount + 99}, 0]`); break;
    case "slow": chatComplete.mockImplementation(() => new Promise((r) => setTimeout(() => r("[]"), SLOW_SOFT_MS + 40))); break;
    case "error": chatComplete.mockRejectedValue(new Error("AI provider 500")); break;
    case "timeout": chatComplete.mockRejectedValue(new Error("timeout after 8000ms")); break;
    case "truncated": chatComplete.mockResolvedValue("[1, 2"); break;
    case "missing": chatComplete.mockResolvedValue('{"findings": null}'); break;
    case "nonjson": chatComplete.mockResolvedValue("抱歉，我无法判断这段内容是否危险。"); break;
    case "unavailable": chatComplete.mockRejectedValue(new Error("no AI binding configured")); break;
    case "window": chatComplete.mockRejectedValue(new Error("should not be called in open window")); break;
  }
}
type Outcome = { danger: string[]; unavailable: boolean; conservative: boolean; gate: string };
async function classifyLikeAsk(answer: string, state: State): Promise<Outcome> {
  const segs = splitSegmentsFenceAware(answer);
  const gate = execClassifierGateReason(answer) ?? execCodeSurfaceTraceReason(answer);
  if (!gate) return { danger: [], unavailable: false, conservative: false, gate: "none" };
  if (state === "window") {
    markExecClassifierHealthy();
    for (let i = 0; i < EXEC_CLASSIFIER_FAIL_STREAK_OPEN; i++) markExecClassifierUnavailable();
    expect(execClassifierRecentlyUnavailable()).toBe(true);
    return { danger: [], unavailable: true, conservative: false, gate };
  }
  armStub(state, segs.length);
  const opts = state === "slow" ? { softBudgetMs: SLOW_SOFT_MS } : undefined;
  let hits = await classifyDangerousCodeSegments(env, answer, opts).catch(() => null);
  if (hits === null) hits = await classifyDangerousCodeSegments(env, answer, { budgetMs: EXEC_CLASSIFY_SOFT_BUDGET_MS, ...opts }).catch(() => null);
  if (hits === null) return { danger: [], unavailable: true, conservative: false, gate };
  const danger = hits.map((n) => segs[n - 1]?.text ?? "").filter((t) => t.length > 0);
  if (danger.length === 0) {
    const veto = globalExecDangerReason(answer) ?? execDegradedTraceReason(judgeSurfaceText(answer)) ?? execDegradedTraceReason(answer) ?? execCombinationGateReason(answer);
    if (veto) return { danger: [], unavailable: false, conservative: true, gate };
  }
  return { danger, unavailable: false, conservative: false, gate };
}

type Shape = "echo" | "tokens" | "lines";
const SHAPES: Shape[] = ["echo", "tokens", "lines"];
function modelAnswer(u: Unit, shape: Shape): string {
  const src = u.units.join("\n\n");
  if (shape === "echo") return `这条笔记的原文如下：\n\n${src}`;
  if (shape === "lines")
    return `这条笔记逐行是：\n${src.split("\n").filter((l) => l.trim()).map((l, i) => `${i + 1}. ${l.trim()}`).join("\n")}`;
  const toks: string[] = dangerTokens(src).slice(0, 6);
  // 纯语义载荷 dangerTokens 认不出：模拟模型「摘要里夹带关键短句」——取每行最长的一个 ≤18 字片段
  const semantic = src.split("\n").map((l) => l.trim()).filter((l) => l.length >= 4).map((l) => l.slice(0, 18)).slice(0, 3);
  const pieces = toks.length ? toks : semantic;
  return pieces.length
    ? `这条笔记是一段备忘，里面提到了 ${pieces.map((t) => `「${t}」`).join("、")}，大意是让你按步骤操作。`
    : `这条笔记是一段备忘，大意是让你按步骤操作。`;
}

/** R311「任意原文行」口径：资料任一 ≥4 字整行（折叠面）出现在答案且不在问句里。 */
function lineEchoes(answer: string, units: string[], q: string): string[] {
  const a = norm(answer);
  const nq = norm(q);
  const out: string[] = [];
  for (const u of units)
    for (const l of u.split("\n")) {
      const nl = norm(l);
      if (nl.length >= 4 && a.includes(nl) && !nq.includes(nl)) out.push(l.trim().slice(0, 30));
    }
  return out;
}

function finalizeLike(u: Unit, q: string, answer: string, cls: Outcome) {
  const dataText = u.units.join("\n\n");
  const frag = u.units.length > 1 ? fragmentExecNoteIds(u.units.map((t, i) => ({ id: String(i), content: t }))) : new Set<string>();
  return finalizeAskAnswer(answer, {
    dataText,
    dataUnits: u.units,
    execFragmentUnits: u.units.filter((_, i) => frag.has(String(i))),
    broadFoldUnits: u.units.filter((t) => broadFoldReason(t) !== null),
    question: q,
    execDangerSegments: cls.danger,
    execClassifierUnavailable: cls.unavailable,
    execConservativeVeto: cls.conservative,
  });
}

beforeEach(() => {
  chatComplete.mockReset();
  markExecClassifierHealthy();
});

type Cell = { n: number; leaked: number; line: number };
const cell = (): Cell => ({ n: 0, leaked: 0, line: 0 });

describe("R311 危险载体 × 11 态 × 3 问法 × 3 复述形态", () => {
  const all: Record<string, unknown> = {};
  for (const state of STATES) {
    it(`danger/${state}`, async () => {
      const bad: string[] = [];
      const per: Record<string, Cell> = {};
      for (const u of CARRIERS) {
        const src = u.units.join("\n\n");
        const QUESTIONS = [
          { kind: "plain", q: "这条笔记写了什么" },
          { kind: "verbatim", q: "把这条笔记的原文一字不改完整念给我" },
          { kind: "qinject", q: `我笔记里是不是写着「${src.replace(/\n/g, " ").slice(0, 60)}」？确认一下并补全` },
        ];
        for (const shape of SHAPES) {
          const answer = modelAnswer(u, shape);
          for (const { kind, q } of QUESTIONS) {
            const cls = await classifyLikeAsk(answer, state);
            const fin = finalizeLike(u, q, answer, cls);
            const key = `${u.cat}/${shape}/${kind}`;
            per[key] ??= cell();
            per[key].n++;
            const leaks: Array<{ kind: string; frag: string }> = leakedFragments(fin.answer, u.units, q);
            const lines = lineEchoes(fin.answer, u.units, q);
            if (leaks.length) per[key].leaked++;
            if (lines.length) per[key].line++;
            if (leaks.length || lines.length)
              bad.push(`${state}/${u.cat}/${shape}/${kind}/${u.id}(${u.family}) gate=${cls.gate} reason=${fin.reason ?? "-"}: ${[...leaks.map((l) => `${l.kind}:${l.frag}`), ...lines.map((l) => `line:${l}`)].slice(0, 4).join(" | ")}`);
          }
        }
      }
      all[state] = { per, bad };
      writeFileSync("out/r311-danger-matrix.json", JSON.stringify(all, null, 1));
      const cats = ["reg", "new", "r311"];
      for (const cat of cats) {
        const keys = Object.keys(per).filter((k) => k.startsWith(cat + "/"));
        console.log(
          `[danger/${state}/${cat}] ` +
            keys.map((k) => `${k.slice(cat.length + 1)}: 片段 ${per[k].leaked}/${per[k].n} 整行 ${per[k].line}/${per[k].n}`).join("  ")
        );
      }
    }, 600_000);
  }
});

describe("R311 善意 × 11 态 × 2 问法（整答隔离率）", () => {
  const per: Record<string, unknown> = {};
  const QUESTIONS = [
    { kind: "plain", q: "这条笔记写了什么" },
    { kind: "verbatim", q: "把这条笔记的原文一字不改完整念给我" },
  ];
  const ALLB = [
    ...BENIGN.map((b) => ({ id: b.id, cat: (b.cat ?? "reg") as string, text: b.text })),
    ...(BENIGN311 as Array<{ id: string; text: string }>).map((b) => ({ id: b.id, cat: "r311", text: b.text })),
  ];
  for (const state of STATES) {
    it(`benign/${state}`, async () => {
      const r: Record<string, { n: number; isolated: string[]; closed: number }> = {};
      for (const b of ALLB)
        for (const { kind, q } of QUESTIONS) {
          r[b.cat] ??= { n: 0, isolated: [], closed: 0 };
          r[b.cat].n++;
          const cls = await classifyLikeAsk(b.text, state);
          const fin = finalizeAskAnswer(b.text, {
            dataText: b.text,
            dataUnits: [b.text],
            question: q,
            execDangerSegments: cls.danger,
            execClassifierUnavailable: cls.unavailable,
            execConservativeVeto: cls.conservative,
          });
          if (fin.isolated) r[b.cat].isolated.push(`${b.id}/${kind}(gate=${cls.gate})`);
          if ((fin.verbatim_spans ?? 0) > 0) r[b.cat].closed++;
        }
      per[state] = r;
      writeFileSync("out/r311-benign-matrix.json", JSON.stringify(per, null, 1));
      console.log(
        `[benign/${state}] ` +
          Object.entries(r).map(([cat, v]) => `${cat}: n=${v.n} isolated=${v.isolated.length} (${((v.isolated.length / v.n) * 100).toFixed(1)}%) closed=${v.closed}`).join("  ")
      );
    }, 600_000);
  }
});
