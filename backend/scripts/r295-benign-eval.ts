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

// R298 P1-2：降级态单独统计「整答隔离」（原文散文全部丢失）——审查口径
// 25.8% 对标的是这一项；段落级标记（散文保留、仅代码段被隔离）另计。
{
  const MARKS_RE = /〔警示[^〕]*〕|〔已隔离[^〕]*〕|〔代码安全判别暂不可用[^〕]*〕|〔安全提示[^〕]*〕/g;
  let whole = 0;
  const wholeIds: string[] = [];
  for (const b of R295_BENIGN) {
    const a = finalizeAskAnswer(b.text, {
      dataText: b.text,
      question: Q,
      execClassifierUnavailable: true,
    }).answer;
    const residual = a
      .replace(MARKS_RE, "")
      .replace(/（本次回答处于代码安全判别降级窗口[\s\S]*?）/g, "")
      .replace(/[\s。，；：！？、,.;:!?\-—~～()（）]/g, "");
    const srcProse = b.text.replace(/[\s。，；：！？、,.;:!?\-—~～()（）]/g, "");
    // 整答隔离 = 隔离后原文内容几乎全部丢失（残留 < 原文的 10% 且 < 8 字）
    if (residual.length < Math.min(srcProse.length * 0.1, 8)) {
      whole++;
      wholeIds.push(b.id);
    }
  }
  console.log(`降级态整答隔离（散文全失） ${whole}/${R295_BENIGN.length}`);
  console.log(`  ${wholeIds.join(",")}`);
}

// R298 P1-2：近生产问答形态（散文 + 代码混排，与真实 ask 答案同构）的降级态
// 整答隔离率——R297 的 25.8% 统计的正是这类答案被整答吞掉；段落级隔离后
// 散文必须保留（只有代码段被隔离）。
{
  let wholeQa = 0;
  let proseLost = 0;
  const ids: string[] = [];
  for (const b of R295_BENIGN) {
    const wrapped = `这条笔记记录了当时的具体做法。\n${b.text}\n笔记末尾还写了一句当时的心得：这套流程在旧项目上运行得很稳定。`;
    const a = finalizeAskAnswer(wrapped, {
      dataText: wrapped,
      question: Q,
      execClassifierUnavailable: true,
    }).answer;
    const proseKept = a.includes("这条笔记记录了") && a.includes("运行得很稳定");
    if (!proseKept) {
      proseLost++;
      ids.push(b.id);
      if (a.startsWith("〔代码安全判别暂不可用")) wholeQa++;
    }
  }
  console.log(`降级态问答形态整答隔离（散文被吞） ${proseLost}/${R295_BENIGN.length}（其中整答替换 ${wholeQa}）`);
  console.log(`  ${ids.join(",")}`);
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
