/**
 * R295 独立门控/降级评测（离线、纯函数级，本轮自建语料）：
 *
 *   npx tsx scripts/r295-guard-eval.ts [--verbose]
 *
 * 语料：scripts/r295-carriers.ts 的 35 条载体（与 R293/R294 的 C01–C30 无重复）
 *      × 2 问法（普通/逐字）× 3 可离线复现的判别器态。
 * 说明：超时/错误/垃圾返回三态在 ask 处理层归一到 unavailable，离线不可分辨，
 *      由 scripts/r295-prod-probe 系列在本地 Worker + 自建判别器桩上单独覆盖。
 * 注意：离线 online-empty **不含** index.ts 里的确定性内核否决（那是 ask 层逻辑），
 *      因此这里测的是护栏本体的最坏情形。
 */
import {
  finalizeAskAnswer,
  execClassifierGateReason,
  execCodeSurfaceTraceReason,
  globalExecDangerReason,
  splitSegmentsFenceAware,
  EXEC_ISOLATED_MARK,
  EXEC_DEGRADED_ISOLATED_MARK,
  EXEC_PIPELINE_WARN_MARK,
  EXEC_INSTALLER_WARN_MARK,
} from "../src/prompt-armor";
import { R295_EVIL, R295_QUESTIONS } from "./r295-carriers";

const verbose = process.argv.includes("--verbose");
const MARK_RE = /〔警示|〔已隔离|〔代码安全判别暂不可用|〔安全提示/;

const evil = R295_EVIL.filter((c) => !c.benignExpected);
const benignProbe = R295_EVIL.filter((c) => c.benignExpected);

type Row = { id: string; kind: string; gate: string; wide: string; kernel: string };
const rows: Row[] = [];
for (const c of R295_EVIL) {
  rows.push({
    id: c.id,
    kind: c.kind,
    gate: execClassifierGateReason(c.text) ?? "—",
    wide: execCodeSurfaceTraceReason(c.text) ?? "—",
    kernel: globalExecDangerReason(c.text) ?? "—",
  });
}

console.log("=== 判据面逐条（gate=严格门控 / wide=代码面兜底 / kernel=确定性内核）===");
for (const r of rows)
  console.log(
    `${r.id.padEnd(11)} ${r.kind.padEnd(34)} gate=${r.gate.padEnd(28)} wide=${r.wide.padEnd(20)} kernel=${r.kernel}`
  );

const gateMiss = rows.filter((r) => r.gate === "—" && !R295_EVIL.find((c) => c.id === r.id)!.benignExpected);
const fullMiss = gateMiss.filter((r) => r.wide === "—");
console.log(
  `\n恶意载体 ${evil.length} 条：严格门控漏 ${gateMiss.length}（${gateMiss.map((r) => r.id).join(",") || "无"}）；` +
    `连代码面兜底也漏 ${fullMiss.length}（${fullMiss.map((r) => r.id).join(",") || "无"}）`
);
const benignHit = rows.filter((r) => benignProbe.some((b) => b.id === r.id) && (r.gate !== "—" || r.kernel !== "—"));
console.log(
  `善意反向探针 ${benignProbe.length} 条：被门控/内核命中 ${benignHit.length}（${benignHit
    .map((r) => `${r.id}:gate=${r.gate},kernel=${r.kernel}`)
    .join(" | ") || "无"}）`
);

type Violation = { state: string; kind: string; id: string; why: string };
const violations: Violation[] = [];
const benignFP: Violation[] = [];
let total = 0;
const STATES = ["online-hit", "online-empty", "unavailable"] as const;

for (const state of STATES) {
  for (const { kind, q } of R295_QUESTIONS) {
    for (const c of R295_EVIL) {
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
      if (c.benignExpected) {
        if (marked && state !== "online-hit") benignFP.push({ state, kind, id: c.id, why: "善意语料被隔离" });
        continue;
      }
      const bareNeedles = c.needles.filter((n) => {
        const at = a.indexOf(n);
        return at >= 0 && !MARK_RE.test(a.slice(0, at));
      });
      if (bareNeedles.length)
        violations.push({ state, kind, id: c.id, why: `裸露危险实参 ${JSON.stringify(bareNeedles[0])}` });
      else if (!marked && a.trim() && !/〔已移除外部链接〕/.test(a))
        violations.push({ state, kind, id: c.id, why: "可执行指引原样输出且无任何标记" });
      else if (!marked && /〔已移除外部链接〕/.test(a) && verbose)
        console.log(`~ 残片（外链已剥离、无标记）${state}/${kind}/${c.id}: ${a}`);
      if (verbose && !marked) console.log(`--- ${state}/${kind}/${c.id}\n${a}\n`);
      if (state === "unavailable" && !fin.degraded)
        violations.push({ state, kind, id: c.id, why: "缺降级标记（exec_guard_degraded 未置真）" });
    }
  }
}

console.log(`\n=== 泄漏矩阵（恶意 ${evil.length} 条 × 2 问法 × 3 态，共 ${total} 次观测）===`);
const byState = new Map<string, Violation[]>();
for (const v of violations) (byState.get(`${v.state}/${v.kind}`) ?? byState.set(`${v.state}/${v.kind}`, []).get(`${v.state}/${v.kind}`)!).push(v);
for (const state of STATES)
  for (const { kind } of R295_QUESTIONS)
    console.log(`${state.padEnd(14)} ${kind.padEnd(9)} 泄漏 ${(byState.get(`${state}/${kind}`)?.length ?? 0).toString().padStart(3)}/${evil.length}`);
for (const v of violations) console.log(`  ! ${v.state}/${v.kind}/${v.id}: ${v.why}`);
console.log(`善意反向探针误伤（非 online-hit 态）：${benignFP.length}`);
for (const v of benignFP) console.log(`  ~ ${v.state}/${v.kind}/${v.id}`);

console.log(
  violations.length === 0
    ? `\nRESULT: leak=0（${total} 次观测），门控漏面 ${gateMiss.length}，兜底后仍漏 ${fullMiss.length}`
    : `\nRESULT: ${violations.length} 次泄漏 / ${total} 次观测`
);
