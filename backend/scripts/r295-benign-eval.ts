/**
 * R295 独立善意误伤评测：
 *   npx tsx scripts/r295-benign-eval.ts [--verbose]
 * 语料：scripts/r295-benign.ts（本轮自建 ≥120 例）
 * 两态分别统计：
 *   normal      判别器在线且零命中（execDangerSegments=[]）——常态下的误伤
 *   degraded    判别器不可用（execClassifierUnavailable=true）——降级态误伤
 * 误伤定义：答案里出现隔离/警示标记，或答案被替换为不含原文的隔离占位。
 */
import {
  finalizeAskAnswer,
  EXEC_ISOLATED_MARK,
  EXEC_DEGRADED_ISOLATED_MARK,
  EXEC_PIPELINE_WARN_MARK,
  EXEC_INSTALLER_WARN_MARK,
} from "../src/prompt-armor";
import { R295_BENIGN } from "./r295-benign";

const verbose = process.argv.includes("--verbose");
const MARK_RE = /〔警示|〔已隔离|〔代码安全判别暂不可用|〔安全提示/;
const Q = "帮我回顾一下这条技术笔记";

type Res = { id: string; cat: string; mark: string };
const out: Record<string, Res[]> = { normal: [], degraded: [] };

for (const state of ["normal", "degraded"] as const) {
  for (const b of R295_BENIGN) {
    const opts =
      state === "degraded" ? { execClassifierUnavailable: true } : { execDangerSegments: [] as string[] };
    const a = finalizeAskAnswer(b.text, { dataText: b.text, question: Q, ...opts }).answer;
    const hit =
      a.includes(EXEC_ISOLATED_MARK) ||
      a.includes(EXEC_DEGRADED_ISOLATED_MARK) ||
      a.includes(EXEC_PIPELINE_WARN_MARK) ||
      a.includes(EXEC_INSTALLER_WARN_MARK) ||
      MARK_RE.test(a);
    if (hit) {
      out[state].push({ id: b.id, cat: b.cat, mark: (a.match(MARK_RE)?.[0] ?? "mark") });
      if (verbose) console.log(`[${state}] ${b.id} ${b.cat}\n  in : ${JSON.stringify(b.text.slice(0, 90))}\n  out: ${JSON.stringify(a.slice(0, 160))}`);
    }
  }
}

const n = R295_BENIGN.length;
const byCat = (rs: Res[]) => {
  const m = new Map<string, number>();
  for (const r of rs) m.set(r.cat, (m.get(r.cat) ?? 0) + 1);
  return [...m].map(([k, v]) => `${k}:${v}`).join(" ");
};
console.log(`语料 ${n} 例`);
console.log(`常态（在线零命中）误伤 ${out.normal.length}/${n}  ${byCat(out.normal)}`);
console.log(`  ${out.normal.map((r) => r.id).join(",")}`);
console.log(`降级态（判别器不可用）误伤 ${out.degraded.length}/${n}  ${byCat(out.degraded)}`);
console.log(`  ${out.degraded.map((r) => r.id).join(",")}`);
