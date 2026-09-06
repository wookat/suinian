/**
 * R324 本地探针（R323 probe-context 的同语料复跑，改为直接调用生产同一份上下文拼装 modelContextNoteText
 * —— 替换先于中和 / 剥离 / 截断 + 归一化复查 fail-closed），并叠加 R324 A 方案 2 的确定性闸门：
 * 取值型凭证问题（isSecretValueQuestion）/ 预言机形态（isOracleProbeQuestion）命中在讲秘密的笔记时直答恒为占位，不进生成。
 * 量：危险片段是否仍进模型上下文（ctx_leak）；最坏 answer 过出口后 needles 是否存活（exit_leak）；善意误占位（benign guarded）。
 * 用法：npx tsx scripts/qa-r324/probe-context.ts [blind|informed|all]
 */
import { ALL as BLIND } from "../qa-r323/blind-carriers";
import { INFORMED } from "../qa-r323/informed-carriers";
import { modelContextNoteText } from "../../src/ask-context";
import {
  directGuardLines,
  crossUnitGuardedLines,
  finalizeAskAnswer,
  normalizeForLeakCompare,
  isSecretValueQuestion,
  isOracleProbeQuestion,
  unitTalksAboutSecret,
  DIRECT_GUARD_PLACEHOLDER,
  ORACLE_NEUTRAL_NOTICE,
} from "../../src/prompt-armor";

// index.ts askGuardNoteUnit 同形（title\ncontent\nurl_title\nurl_summary；skip_triage 文本笔记只有 content）
const askGuardNoteUnit = (content: string): string => `\n${content}\n\n`;

const sel = process.argv[2] ?? "all";
const items = sel === "blind" ? BLIND : sel === "informed" ? INFORMED : [...BLIND, ...INFORMED];
const BUDGET = 500; // perNoteBudget 下限（召回 ≥24 条时），最严苛裁剪

let ctxLeak = 0, unguarded = 0, exitLeak = 0, dangerN = 0, benignGuarded = 0, benignN = 0, gated = 0, benignGated = 0;
for (const c of items) {
  const units = c.texts.map((t) => askGuardNoteUnit(t));
  const cross = crossUnitGuardedLines(units);
  const ctx = c.texts.map((t, i) => modelContextNoteText({ title: null, content: t, unit: units[i], crossGuarded: cross, budget: BUDGET }).text);
  const guards = units.map((u) => directGuardLines(u));
  const anyGuard = guards.some((g) => g.length > 0) || cross.size > 0;
  const ctxNorm = normalizeForLeakCompare(ctx.join("\n"));
  const inCtx = c.needles.filter((n) => normalizeForLeakCompare(n).length >= 3 && ctxNorm.includes(normalizeForLeakCompare(n)));
  const question = c.asks[c.asks.length - 1];
  const talking = units.some((u) => unitTalksAboutSecret(u, cross));
  // R324 A 方案 2 / D：直答前的确定性闸门（index.ts ask 路由同序：预言机 → 取值型），命中即占位，模型答案不参与。
  const gate = talking && isOracleProbeQuestion(question) ? "oracle" : talking && isSecretValueQuestion(question, c.asks.slice(0, -1).join("\n")) ? "value" : null;
  const fin = gate
    ? { answer: gate === "oracle" ? ORACLE_NEUTRAL_NOTICE : DIRECT_GUARD_PLACEHOLDER.credential, changed: true }
    : finalizeAskAnswer(c.answer, {
        dataText: c.texts.join("\n"),
        dataUnits: c.texts,
        question,
        verbatimExempt: c.asks.join("\n"),
        tier: c.texts.length === 1 ? { kind: "single_note_direct", directUnit: c.texts[0] } : { kind: "aggregate" },
      });
  const finNorm = normalizeForLeakCompare(fin.answer);
  const exitSurvive = c.needles.filter((n) => normalizeForLeakCompare(n).length >= 3 && finNorm.includes(normalizeForLeakCompare(n)));
  if (c.cat === "danger") {
    dangerN++;
    if (!anyGuard) unguarded++;
    if (gate) gated++;
    if (inCtx.length) ctxLeak++;
    if (exitSurvive.length) exitLeak++;
    if (!anyGuard || inCtx.length || exitSurvive.length)
      console.log(
        `${c.id} [${c.family}${c.seam ? "/" + c.seam : ""}] ${!anyGuard ? "UNGUARDED " : ""}${inCtx.length ? "CTX-LEAK " : ""}${exitSurvive.length ? "EXIT-LEAK " : ""}` +
          `gate=${gate ?? "-"} guards=${guards.map((g) => g.map((x) => `${x.kind}${x.own ? "" : "*"}`).join(",") || "-").join("|")} cross=${cross.size} ctx=${JSON.stringify(inCtx)} exit=${JSON.stringify(exitSurvive)}\n   ctx0=${ctx[0].replace(/\n/g, "⏎").slice(0, 160)}`
      );
  } else {
    benignN++;
    if (gate) benignGated++;
    if (anyGuard || fin.changed) {
      benignGuarded++;
      console.log(`${c.id} benign GUARDED gate=${gate ?? "-"} guards=${guards.map((g) => g.map((x) => x.kind).join(",") || "-").join("|")} changed=${fin.changed} src=${c.texts[0].slice(0, 60)} q=${question.slice(0, 40)}`);
    }
  }
}
console.log(`\n== ${sel}: danger=${dangerN} unguarded=${unguarded} gated=${gated} ctx_leak=${ctxLeak} exit_leak=${exitLeak} | benign=${benignN} guarded=${benignGuarded} gated=${benignGated}`);
