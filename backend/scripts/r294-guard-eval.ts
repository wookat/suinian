/**
 * R294 恶意矩阵量化评测（离线、纯函数级）：
 *
 *   npx tsx scripts/r294-guard-eval.ts [--verbose]
 *
 * 语料：scripts/r294-eval-data.ts 的 30 载体（audit-r293 §2 全部 fail-open 形态）
 *      × 2 问法（普通/逐字）× 3 判别器态：
 *        online-hit    判别器在线且命中（把全部分段判危）
 *        online-empty  判别器在线但零命中（R293 实测 10 次裸泄漏的态）
 *        unavailable   判别器不可用（超时/错误/无 binding 归一到此态）
 * 通过标准：
 *  - 任一态、任一问法：危险实参不得出现在无前置标记的位置（leak=0）；
 *  - 门控（execClassifierGateReason）必须对每条载体给出非 null 理由；
 *  - unavailable 态必须落降级标记（degraded=true）。
 */
import {
  finalizeAskAnswer,
  execClassifierGateReason,
  splitSegmentsFenceAware,
  EXEC_ISOLATED_MARK,
  EXEC_DEGRADED_ISOLATED_MARK,
  EXEC_PIPELINE_WARN_MARK,
  EXEC_INSTALLER_WARN_MARK,
} from "../src/prompt-armor";
import { R294_EVIL, R294_QUESTIONS } from "./r294-eval-data";

const verbose = process.argv.includes("--verbose");

const MARK_RE = /〔警示|〔已隔离|〔代码安全判别暂不可用|〔安全提示/;

type Violation = { state: string; kind: string; id: string; why: string };
const violations: Violation[] = [];
let total = 0;

const gateMiss: string[] = [];
for (const c of R294_EVIL) {
  if (execClassifierGateReason(c.text) === null) gateMiss.push(c.id);
}

const STATES = ["online-hit", "online-empty", "unavailable"] as const;

for (const state of STATES) {
  for (const { kind, q } of R294_QUESTIONS) {
    for (const c of R294_EVIL) {
      total++;
      const opts =
        state === "unavailable"
          ? { execClassifierUnavailable: true }
          : state === "online-hit"
            ? { execDangerSegments: splitSegmentsFenceAware(c.text).map((s) => s.text) }
            : { execDangerSegments: [] as string[] };
      const fin = finalizeAskAnswer(c.text, { dataText: c.text, question: q, ...opts });
      const a = fin.answer;
      const marked =
        a.includes(EXEC_ISOLATED_MARK) ||
        a.includes(EXEC_DEGRADED_ISOLATED_MARK) ||
        a.includes(EXEC_PIPELINE_WARN_MARK) ||
        a.includes(EXEC_INSTALLER_WARN_MARK) ||
        MARK_RE.test(a);
      if (!marked) {
        violations.push({ state, kind, id: c.id, why: "无任何标记（裸泄漏）" });
        if (verbose) console.log(`--- ${state}/${kind}/${c.id}\n${a}\n`);
        continue;
      }
      for (const n of c.needles) {
        const at = a.indexOf(n);
        if (at < 0) continue;
        if (!MARK_RE.test(a.slice(0, at)))
          violations.push({ state, kind, id: c.id, why: `裸露 ${JSON.stringify(n)}` });
      }
      if (state === "unavailable" && !fin.degraded)
        violations.push({ state, kind, id: c.id, why: "缺降级标记" });
    }
  }
}

console.log(`门控漏面（execClassifierGateReason=null）：${gateMiss.length}/${R294_EVIL.length}` +
  (gateMiss.length ? ` → ${gateMiss.join(",")}` : ""));
const byState = new Map<string, number>();
for (const v of violations) byState.set(`${v.state}/${v.kind}`, (byState.get(`${v.state}/${v.kind}`) ?? 0) + 1);
for (const state of STATES)
  for (const { kind } of R294_QUESTIONS)
    console.log(
      `${state.padEnd(14)} ${kind.padEnd(9)} 泄漏 ${(byState.get(`${state}/${kind}`) ?? 0)
        .toString()
        .padStart(3)}/${R294_EVIL.length}`
    );
if (violations.length)
  for (const v of violations.slice(0, 40))
    console.log(`  ${v.state}/${v.kind}/${v.id}: ${v.why}`);

const ok = violations.length === 0 && gateMiss.length === 0;
console.log(
  ok
    ? `\nOK: ${total} 次观测 leak=0，门控 0 漏面`
    : `\nFAIL: ${violations.length} 次泄漏 / ${gateMiss.length} 条门控漏面（共 ${total} 次观测）`
);
process.exit(ok ? 0 : 1);
