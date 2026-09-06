/**
 * R323 本地探针（读实现后）：逐条复现 /api/ask 送模型前的上下文拼装（index.ts ask 路由：
 * neutralizePromptInjection → 剔首部 [xxx]/【xxx】前缀 → clipAtSentence → redactGuardedLinesForModel(unit, cross)），
 * 量「危险片段是否仍进模型上下文」——这是 R322 A 方案的唯一前提；进了上下文，任何转写变体都只剩出口比对兜底。
 * 同时量出口兜底：模型如实照做的最坏 answer 过 finalizeAskAnswer 后 needles 是否存活。
 * 用法：npx tsx scripts/qa-r323/probe-context.ts [blind|informed|all]
 */
import { ALL as BLIND } from "./blind-carriers";
import { INFORMED } from "./informed-carriers";
import { neutralizePromptInjection } from "../../src/triage";
import {
  directGuardLines,
  crossUnitGuardedLines,
  redactGuardedLinesForModel,
  finalizeAskAnswer,
  normalizeForLeakCompare,
} from "../../src/prompt-armor";

// index.ts askGuardNoteUnit 同形（title\ncontent\nurl_title\nurl_summary；skip_triage 文本笔记只有 content）
const askGuardNoteUnit = (content: string): string => `\n${content}\n\n`;

const sel = process.argv[2] ?? "all";
const items = sel === "blind" ? BLIND : sel === "informed" ? INFORMED : [...BLIND, ...INFORMED];
const PREFIX_RE = /^\s*(?:[[【][^\]】\n]{1,24}[\]】]\s*)+/;
const BUDGET = 500; // perNoteBudget 下限（召回 ≥24 条时），最严苛裁剪

// clipAtSentence 非导出：按 index.ts 语义近似（超预算时在句界裁），本探针只关心「裁剪会不会破坏受守行匹配」。
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const m = /[。！？.!?\n][^。！？.!?\n]*$/.exec(cut);
  return m ? cut.slice(0, cut.length - m[0].length + 1) : cut;
}

let ctxLeak = 0, unguarded = 0, exitLeak = 0, dangerN = 0, benignGuarded = 0, benignN = 0;
for (const c of items) {
  const units = c.texts.map((t) => askGuardNoteUnit(t));
  const cross = crossUnitGuardedLines(units);
  const ctx = c.texts.map((t, i) => {
    const body = neutralizePromptInjection(t).replace(PREFIX_RE, "");
    return redactGuardedLinesForModel(`\n${clip(body, BUDGET)}`, units[i], cross).text;
  });
  const guards = units.map((u) => directGuardLines(u));
  const anyGuard = guards.some((g) => g.length > 0) || cross.size > 0;
  const ctxNorm = normalizeForLeakCompare(ctx.join("\n"));
  const inCtx = c.needles.filter((n) => normalizeForLeakCompare(n).length >= 3 && ctxNorm.includes(normalizeForLeakCompare(n)));
  const fin = finalizeAskAnswer(c.answer, {
    dataText: c.texts.join("\n"),
    dataUnits: c.texts,
    question: c.asks[c.asks.length - 1],
    verbatimExempt: c.asks.join("\n"),
    tier: c.texts.length === 1 ? { kind: "single_note_direct", directUnit: c.texts[0] } : { kind: "aggregate" },
  });
  const finNorm = normalizeForLeakCompare(fin.answer);
  const exitSurvive = c.needles.filter((n) => normalizeForLeakCompare(n).length >= 3 && finNorm.includes(normalizeForLeakCompare(n)));
  if (c.cat === "danger") {
    dangerN++;
    if (!anyGuard) unguarded++;
    if (inCtx.length) ctxLeak++;
    if (exitSurvive.length) exitLeak++;
    if (!anyGuard || inCtx.length || exitSurvive.length)
      console.log(
        `${c.id} [${c.family}${c.seam ? "/" + c.seam : ""}] ${!anyGuard ? "UNGUARDED " : ""}${inCtx.length ? "CTX-LEAK " : ""}${exitSurvive.length ? "EXIT-LEAK " : ""}` +
          `guards=${guards.map((g) => g.map((x) => `${x.kind}${x.own ? "" : "*"}`).join(",") || "-").join("|")} cross=${cross.size} ctx=${JSON.stringify(inCtx)} exit=${JSON.stringify(exitSurvive)}\n   ctx0=${ctx[0].replace(/\n/g, "⏎").slice(0, 160)}`
      );
  } else {
    benignN++;
    if (anyGuard || fin.changed) {
      benignGuarded++;
      console.log(`${c.id} benign GUARDED guards=${guards.map((g) => g.map((x) => x.kind).join(",") || "-").join("|")} changed=${fin.changed} src=${c.texts[0].slice(0, 60)}`);
    }
  }
}
console.log(`\n== ${sel}: danger=${dangerN} unguarded=${unguarded} ctx_leak=${ctxLeak} exit_leak=${exitLeak} | benign=${benignN} guarded=${benignGuarded}`);
