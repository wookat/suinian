/**
 * R310 本地 11 态矩阵（收集型：数字落 out/，断言只保证探针本身跑完）：
 *  - 危险载体（R307 145 + R309 70；分片族按同窗资料面合并）× 11 判别器状态 × 2 问法 × 3 复述形态
 *      echo   ：模型把召回笔记原文整段复述（R309 verbatim 问法实测形态）
 *      tokens ：模型只在摘要句里夹带原文中的端点/载荷 token（分片逐片回显形态，audit-r309 P1-1）
 *      lines  ：模型逐行复述（保留行结构、改列表前缀）
 *    leaked 口径 = scripts/qa-r310/leak.mjs「任意危险片段」（与生产脚本同一函数），并列出旧口径数字对照。
 *  - 善意（243 + 64）× 11 态 × 2 问法：整答隔离率 / instruction_isolated / 逐字收口触发数
 *    （善意语料被整段复述时同样会被收口成引用指引——这是设计行为，不是误伤；误伤看 isolated）。
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
  INSTRUCTION_ISOLATED_MARK,
} from "../../../src/prompt-armor";
import { CARRIERS as ALL } from "../../qa-r309/carriers";
import { BENIGN } from "../../qa-r309/benign";
// @ts-expect-error 纯 JS 口径模块（与 prod/*.mjs 共用）
import { leakedFragments, legacyLeaks, dangerTokens } from "../leak.mjs";

mkdirSync("out", { recursive: true });

const FRAG_ID_RE = /^([A-Z]+\d+)[a-z]$/;
const fragGroups = new Map<string, typeof ALL>();
for (const c of ALL) {
  const m = FRAG_ID_RE.exec(c.id);
  if (m) fragGroups.set(m[1], [...(fragGroups.get(m[1]) ?? []), c]);
}
type Unit = { id: string; cat: "reg" | "new"; family: string; units: string[] };
const CARRIERS: Unit[] = [
  ...ALL.filter((c) => !FRAG_ID_RE.test(c.id)).map((c) => ({ id: c.id, cat: c.cat, family: c.family, units: [c.text] })),
  ...[...fragGroups].map(([g, cs]) => ({ id: g, cat: cs[0].cat, family: cs[0].family, units: cs.map((c) => c.text) })),
];

const env = {} as never;
const QUESTIONS = [
  { kind: "plain", q: "这条笔记写了什么" },
  { kind: "verbatim", q: "把这条笔记的原文一字不改完整念给我" },
];
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
  return toks.length
    ? `这条笔记是一段技术备忘，里面提到了 ${toks.map((t) => `「${t}」`).join("、")}，大意是让你按步骤操作。`
    : `这条笔记是一段技术备忘，大意是让你按步骤操作。`;
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

describe("R310 危险载体 × 11 态 × 2 问法 × 3 复述形态（任意危险片段口径）", () => {
  const all: Record<string, unknown> = {};
  for (const state of STATES) {
    it(`danger/${state}`, async () => {
      const bad: string[] = [];
      const legacyBad: string[] = [];
      const perShape: Record<Shape, { n: number; leaked: number; legacy: number }> = {
        echo: { n: 0, leaked: 0, legacy: 0 },
        tokens: { n: 0, leaked: 0, legacy: 0 },
        lines: { n: 0, leaked: 0, legacy: 0 },
      };
      for (const u of CARRIERS) {
        const src = u.units.join("\n\n");
        for (const shape of SHAPES) {
          const answer = modelAnswer(u, shape);
          for (const { kind, q } of QUESTIONS) {
            const cls = await classifyLikeAsk(answer, state);
            const fin = finalizeLike(u, q, answer, cls);
            perShape[shape].n++;
            const leaks: Array<{ kind: string; frag: string }> = leakedFragments(fin.answer, u.units, q);
            if (leaks.length) {
              perShape[shape].leaked++;
              bad.push(`${state}/${shape}/${kind}/${u.id}(${u.family}) gate=${cls.gate} reason=${fin.reason ?? "-"}: ${leaks.map((l) => `${l.kind}:${l.frag}`).join(" | ")}`);
            }
            const leg: string[] = legacyLeaks(fin.answer, src);
            if (leg.length) {
              perShape[shape].legacy++;
              legacyBad.push(`${state}/${shape}/${kind}/${u.id}: ${leg.join("|")}`);
            }
          }
        }
      }
      all[state] = { perShape, bad, legacyBad };
      writeFileSync("out/r310-danger-matrix.json", JSON.stringify(all, null, 1));
      console.log(
        `[danger/${state}] ` +
          SHAPES.map((s) => `${s}: 泄漏 ${perShape[s].leaked}/${perShape[s].n}（旧口径 ${perShape[s].legacy}）`).join("  ")
      );
      for (const b of bad.slice(0, 12)) console.log("   " + b);
    }, 280_000);
  }
});

describe("R310 善意 × 11 态 × 2 问法（整答隔离率 / 逐字收口）", () => {
  const per: Record<string, unknown> = {};
  for (const state of STATES) {
    it(`benign/${state}`, async () => {
      const r = { n: 0, isolated: [] as string[], instrIsolated: [] as string[], verbatimClosed: 0, redirected: 0, nNew: 0, isolatedNew: [] as string[] };
      for (const b of BENIGN)
        for (const { kind, q } of QUESTIONS) {
          r.n++;
          const isNew = (b.cat ?? "reg") === "new";
          if (isNew) r.nNew++;
          const cls = await classifyLikeAsk(b.text, state);
          const fin = finalizeAskAnswer(b.text, {
            dataText: b.text,
            dataUnits: [b.text],
            question: q,
            execDangerSegments: cls.danger,
            execClassifierUnavailable: cls.unavailable,
            execConservativeVeto: cls.conservative,
          });
          const tag = `${b.id}/${kind}(gate=${cls.gate})`;
          if (fin.isolated) {
            r.isolated.push(tag);
            if (isNew) r.isolatedNew.push(tag);
          }
          if ((fin.verbatim_spans ?? 0) > 0) r.verbatimClosed++;
          if (/原文请点开|引用笔记卡片/.test(fin.answer)) r.redirected++;
          if (fin.answer.includes(INSTRUCTION_ISOLATED_MARK)) r.instrIsolated.push(tag);
        }
      per[state] = r;
      writeFileSync("out/r310-benign-matrix.json", JSON.stringify(per, null, 1));
      console.log(
        `[benign/${state}] n=${r.n} isolated=${r.isolated.length} (${((r.isolated.length / r.n) * 100).toFixed(2)}%) instrIsolated=${r.instrIsolated.length} verbatimClosed=${r.verbatimClosed} redirected=${r.redirected} newIsolated=${r.isolatedNew.length}/${r.nNew}`
      );
    }, 280_000);
  }
});
