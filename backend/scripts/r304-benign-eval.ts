/**
 * R304 P0-D 误伤评测（离线、纯函数级）：
 *
 *   npx tsx scripts/r304-benign-eval.ts [--verbose]
 *
 * 口径与 audit-r303 §8 严格对齐：**整答案隔离率**（用户答案主体被整体替换）
 * 记为误伤；段落级隔离另计。三态：在线零命中 / 判别器不可用（降级）/ 两态合计。
 * 目标（audit-r303 §13 P0-D）：合计 <3%，且远程端点共现的 fail-closed 不放松
 * ——后者由 test/r304-guard-matrix.test.ts 的安全回归单独统计，两边不混算。
 */
import { finalizeAskAnswer, EXEC_DEGRADED_ISOLATED_MARK, EXEC_ISOLATED_MARK } from "../src/prompt-armor";
import { R304_BENIGN } from "./r304-benign";

const verbose = process.argv.includes("--verbose");
const Q = "这条笔记写了什么";
const NOTICE_RE = /（本次回答处于代码安全判别降级窗口[\s\S]*?）/g;
const MARKS_RE = /〔[^〕]*〕/g;
const compact = (s: string) => s.replace(/[\s。，；：！？、,.;:!?\-—~～()（）]/g, "");

const PROSE_HEAD = "这条笔记记录了当时的具体做法。";
const PROSE_TAIL = "笔记末尾还写了一句当时的心得：这套流程在旧项目上运行得很稳定。";
const wrap = (t: string) => `${PROSE_HEAD}\n${t}\n${PROSE_TAIL}`;

export function classifyBenign(text: string, unavailable: boolean): "whole" | "partial" | "clean" {
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

if (process.argv[1] && process.argv[1].includes("r304-benign-eval")) {
  let wholeAll = 0;
  let totalAll = 0;
  for (const state of [false, true]) {
    const buckets: Record<string, string[]> = { whole: [], partial: [], clean: [] };
    for (const c of R304_BENIGN) buckets[classifyBenign(wrap(c.text), state)].push(c.id);
    const label = state ? "降级（判别器不可用）" : "在线（零命中）";
    const pct = ((buckets.whole.length / R304_BENIGN.length) * 100).toFixed(2);
    console.log(
      `R304 善意语料 ${R304_BENIGN.length} 例  ${label.padEnd(22)} 整答案隔离 ${buckets.whole.length} (${pct}%)` +
        ` | 段落级 ${buckets.partial.length} | 未动 ${buckets.clean.length}`
    );
    if (verbose && buckets.whole.length) console.log(`    whole: ${buckets.whole.join(",")}`);
    if (verbose && buckets.partial.length) console.log(`    partial: ${buckets.partial.join(",")}`);
    wholeAll += buckets.whole.length;
    totalAll += R304_BENIGN.length;
  }
  console.log(`\n两态合计 整答案隔离 ${wholeAll}/${totalAll} = ${((wholeAll / totalAll) * 100).toFixed(2)}%（目标 <3%）`);
  console.log("R303 生产基线：22/320 = 6.88%（硬隔离 16 = 5.00%）；本地降级态 15.63%");
}
