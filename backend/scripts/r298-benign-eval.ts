/**
 * R298 P1-2 善意语料统一评测（离线、纯函数级）：
 *
 *   npx tsx scripts/r298-benign-eval.ts [--verbose]
 *
 * 口径与 audit-r297 §4「降级态 34/132（25.8%）」严格对齐：**整答案隔离率**
 * ——即用户拿到的答案里散文主体被整体替换成占位符的比例。段落级隔离（危险
 * 或疑似可执行的那几行被替换、其余正文保留）不计入误伤，那是 P1-2 的目标
 * 形态，也是判别器不可用时的安全下界要求。
 *
 * 三个统计面：
 *   whole   整答案隔离（散文主体全失）——R297 的 25.8% 同口径；
 *   partial 段落级隔离（正文保留 ≥ 一半有效字符）；
 *   clean   未被动过。
 *
 * 语料：R295 130 例 + R290 的 BENIGN_INSTALLERS/BENIGN_DOCS + r288 116 例。
 */
import { finalizeAskAnswer, EXEC_DEGRADED_ISOLATED_MARK, EXEC_ISOLATED_MARK } from "../src/prompt-armor";
import { R295_BENIGN } from "./r295-benign";
import { BENIGN_INSTALLERS, BENIGN_DOCS } from "./r290-eval-data";
import { BENIGN_R288_CASES } from "./r288-eval-data";

const verbose = process.argv.includes("--verbose");
const Q = "这条笔记写了什么";
const NOTICE_RE = /（本次回答处于代码安全判别降级窗口[\s\S]*?）/g;
const MARKS_RE = /〔[^〕]*〕/g;

type Case = { id: string; text: string };
const CORPORA: Array<{ name: string; cases: Case[] }> = [
  { name: "R295 (130)", cases: R295_BENIGN.map((b) => ({ id: b.id, text: b.text })) },
  {
    name: "R290 善意 (installers+docs)",
    cases: [...BENIGN_INSTALLERS, ...BENIGN_DOCS].map((b) => ({ id: b.id, text: b.text })),
  },
  { name: "r288 (116)", cases: BENIGN_R288_CASES.map((c) => ({ id: c.id, text: c.text })) },
];

const compact = (s: string) => s.replace(/[\s。，；：！？、,.;:!?\-—~～()（）]/g, "");

/**
 * 问答形态（与 audit-r297 的 benign-e2e 同口径）：真实答案是「散文 + 笔记内容 +
 * 散文」，而不是把命令原文单独扔出来。裸语料面（形态 raw）里不少条目整条就是
 * 一行命令，判别器不可用时整条隔离是安全下界的必然结果，不是可治理的误伤；
 * 问答形态才能回答「用户还能不能读到答案主体」。
 */
const PROSE_HEAD = "这条笔记记录了当时的具体做法。";
const PROSE_TAIL = "笔记末尾还写了一句当时的心得：这套流程在旧项目上运行得很稳定。";
const wrap = (t: string) => `${PROSE_HEAD}\n${t}\n${PROSE_TAIL}`;

function classify(text: string, unavailable: boolean): "whole" | "partial" | "clean" {
  const a = finalizeAskAnswer(text, {
    dataText: text,
    question: Q,
    ...(unavailable ? { execClassifierUnavailable: true } : { execDangerSegments: [] as string[] }),
  }).answer;
  const residual = compact(a.replace(NOTICE_RE, "").replace(MARKS_RE, ""));
  const src = compact(text);
  if (residual.length < Math.min(src.length * 0.1, 8)) return "whole";
  const touched = a.includes(EXEC_DEGRADED_ISOLATED_MARK) || a.includes(EXEC_ISOLATED_MARK);
  return touched ? "partial" : "clean";
}

const agg: Record<string, { whole: number; total: number }> = {
  "raw/online": { whole: 0, total: 0 },
  "raw/degraded": { whole: 0, total: 0 },
  "qa/online": { whole: 0, total: 0 },
  "qa/degraded": { whole: 0, total: 0 },
};
for (const { name, cases } of CORPORA) {
  for (const shape of ["raw", "qa"] as const)
    for (const state of [false, true]) {
      const buckets: Record<string, string[]> = { whole: [], partial: [], clean: [] };
      for (const c of cases) buckets[classify(shape === "qa" ? wrap(c.text) : c.text, state)].push(c.id);
      const label = state ? "降级（判别器不可用）" : "在线（零命中）";
      const pct = ((buckets.whole.length / cases.length) * 100).toFixed(1);
      console.log(
        `${name.padEnd(28)} ${shape.padEnd(4)} ${label.padEnd(22)} 整答案隔离 ${buckets.whole.length}/${cases.length} (${pct}%)` +
          ` | 段落级 ${buckets.partial.length} | 未动 ${buckets.clean.length}`
      );
      if (verbose && buckets.whole.length) console.log(`    whole: ${buckets.whole.join(",")}`);
      const k = `${shape}/${state ? "degraded" : "online"}`;
      agg[k].whole += buckets.whole.length;
      agg[k].total += cases.length;
    }
}
console.log("");
for (const [k, v] of Object.entries(agg))
  console.log(`合计 ${k.padEnd(14)} 整答案隔离 ${v.whole}/${v.total} (${((v.whole / v.total) * 100).toFixed(1)}%)`);
console.log("R297 基线（问答形态、降级态）：34/132 = 25.8%");
