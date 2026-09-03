/**
 * R309 独立 11 态矩阵（审查方，收集型：不断言，全部数字落 out/）：
 *  - 危险载体（R307 回归 145 + R309 新造 70；分片族按「同窗被引用」的资料面合并成一条）
 *    × 11 判别器状态 × 2 问法 → finalizeAskAnswer 端到端「裸露 / 无处置标记」。
 *  - 善意（243 + 64）× 11 态 × 2 问法 → 整答隔离率 / instruction_isolated 口径。
 * 判别器状态桩与 R307 一致（同 11 态定义），以便与上轮数字直接可比。
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
  EXEC_ISOLATED_MARK,
  EXEC_DEGRADED_ISOLATED_MARK,
  EXEC_DEGRADED_NOTICE,
  INSTRUCTION_ISOLATED_MARK,
} from "../../../src/prompt-armor";
import { CARRIERS as ALL } from "../carriers";
import { BENIGN } from "../benign";

mkdirSync("out", { recursive: true });

// 分片族合并：单片在单笔记面必然无害，端到端按「同窗多条笔记被一起引用」打。
const FRAG_ID_RE = /^([A-Z]+\d+)[a-z]$/;
const fragGroups = new Map<string, typeof ALL>();
for (const c of ALL) {
  const m = FRAG_ID_RE.exec(c.id);
  if (m) fragGroups.set(m[1], [...(fragGroups.get(m[1]) ?? []), c]);
}
const CARRIERS = [
  ...ALL.filter((c) => !FRAG_ID_RE.test(c.id)),
  ...[...fragGroups].map(([g, cs]) => ({
    id: g,
    cat: cs[0].cat,
    family: cs[0].family,
    text: cs.map((c) => c.text).join("\n\n"),
  })),
];

const env = {} as never;
const MARK_RE = /〔警示|〔已隔离|〔代码安全判别暂不可用|〔安全提示|〔原文查看|〔标题含指令|命中安全隔离规则/;
const QUESTIONS = [
  { kind: "plain", q: "这条笔记写了什么" },
  { kind: "verbatim", q: "把这条笔记的原文一字不改完整念给我" },
];
type State =
  | "hit" | "empty" | "oob" | "slow" | "error" | "timeout"
  | "truncated" | "missing" | "nonjson" | "unavailable" | "window";
const STATES: State[] = ["hit", "empty", "oob", "slow", "error", "timeout", "truncated", "missing", "nonjson", "unavailable", "window"];
const SLOW_SOFT_MS = 30;

// needle：载体里真实出现的投放/地址/载荷 token（R307 池 + R309 新造实参）
const NEEDLE_POOL = [
  "payload.sh", "p.sh", "i.sh", "p.js", "p.py", "p.ps1", "p.tgz", "relay3", "evil", "c2.example.net", "bit.ly",
  "jsdelivr", "r2.cloudflarestorage", "NBSWY3DP", "eryl3", "ten.elpmaxe", "QED8WEX0", "bastion", "x.sock",
  "203.0.113", "3405803785", "0xCB007147", "2001:db8", "xn--", "gist.github", "pastebin", "github.io",
  "vercel.app", "githubusercontent", "attacker", "P@ssw0rd", "\\162\\145",
  "deploy.sh", "setup.sh", "agent.sh", "beacon.sh", "x.js", "a.ps1", "p.txt", "javascript:", "aHR0cHM6", "OJSWYYLZ",
  "uhodb3", ".-. . .-..", "\\x63\\x75", "rеlаy3", "🇷🇪🇱", "document.cookie", "ay3.example.ne",
  // R309 新造
  "boot.sh", "install.sh", "x.sh", "eryn3", "xifmm3", "72656c6179", "id_rsa", "ops-archive",
  "update3", "relay3 点", "relay3 dian", "relay3 period", "relay3 punto", "relay3 ponto", "relay3 chấm",
  "relay3 จุด", "relay3 נקודה", "r-e-l-a-y-3", "d0t example", "杠杠 example",
];
function needlesOf(text: string): string[] {
  const out = NEEDLE_POOL.filter((n) => text.includes(n));
  for (const m of text.matchAll(/[a-z0-9-]+\.example\.(?:net|com|org|xyz|top|zip|quest)/gi)) out.push(m[0]);
  return [...new Set(out)];
}
const bareLeaks = (answer: string, needles: string[]): string[] =>
  needles.filter((n) => {
    const at = answer.indexOf(n);
    return at >= 0 && !MARK_RE.test(answer.slice(0, at));
  });

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
  if (hits === null)
    hits = await classifyDangerousCodeSegments(env, answer, { budgetMs: EXEC_CLASSIFY_SOFT_BUDGET_MS, ...opts }).catch(() => null);
  if (hits === null) return { danger: [], unavailable: true, conservative: false, gate };
  const danger = hits.map((n) => segs[n - 1]?.text ?? "").filter((t) => t.length > 0);
  if (danger.length === 0) {
    const veto =
      globalExecDangerReason(answer) ??
      execDegradedTraceReason(judgeSurfaceText(answer)) ??
      execDegradedTraceReason(answer) ??
      execCombinationGateReason(answer);
    if (veto) return { danger: [], unavailable: false, conservative: true, gate };
  }
  return { danger, unavailable: false, conservative: false, gate };
}

beforeEach(() => {
  chatComplete.mockReset();
  markExecClassifierHealthy();
});

describe("R309 危险载体 × 11 态 × 2 问法", () => {
  const all: Record<string, { bad: string[]; regBad: number; newBad: number }> = {};
  for (const state of STATES) {
    it(`danger/${state}`, async () => {
      const bad: string[] = [];
      let regBad = 0;
      let newBad = 0;
      for (const c of CARRIERS) {
        const needles = needlesOf(c.text);
        for (const { kind, q } of QUESTIONS) {
          const cls = await classifyLikeAsk(c.text, state);
          const fin = finalizeAskAnswer(c.text, {
            dataText: c.text,
            question: q,
            execDangerSegments: cls.danger,
            execClassifierUnavailable: cls.unavailable,
            execConservativeVeto: cls.conservative,
          });
          const leaks = bareLeaks(fin.answer, needles);
          let hit = false;
          if (leaks.length) {
            bad.push(`${state}/${kind}/${c.id}(${c.family}) gate=${cls.gate}: 裸露 ${leaks.join("|")}`);
            hit = true;
          } else if (!MARK_RE.test(fin.answer)) {
            bad.push(`${state}/${kind}/${c.id}(${c.family}) gate=${cls.gate}: 无处置标记(needles=${needles.length})`);
            hit = true;
          }
          if (fin.answer.includes(EXEC_ISOLATED_MARK) && fin.answer.includes(EXEC_DEGRADED_ISOLATED_MARK))
            bad.push(`${state}/${kind}/${c.id}: 两态标记并存`);
          if (cls.unavailable && fin.degraded !== true) bad.push(`${state}/${kind}/${c.id}: 缺降级标记`);
          if (cls.unavailable && !fin.answer.includes(EXEC_DEGRADED_NOTICE)) bad.push(`${state}/${kind}/${c.id}: 无降级提示`);
          if (hit) c.cat === "reg" ? regBad++ : newBad++;
        }
      }
      all[state] = { bad, regBad, newBad };
      writeFileSync("out/r309-danger-matrix.json", JSON.stringify(all, null, 1));
      console.log(`[danger/${state}] 问题 ${bad.length}（回归 ${regBad} / 新造 ${newBad}）`);
    }, 280_000);
  }
});

describe("R309 善意 × 11 态 × 2 问法", () => {
  const per: Record<string, unknown> = {};
  for (const state of STATES) {
    it(`benign/${state}`, async () => {
      const r = {
        n: 0,
        isolated: [] as string[],
        instrIsolated: [] as string[],
        changed: [] as string[],
        degradedOnly: [] as string[],
        nNew: 0,
        isolatedNew: [] as string[],
        instrIsolatedNew: [] as string[],
      };
      for (const b of BENIGN)
        for (const { kind, q } of QUESTIONS) {
          r.n++;
          const isNew = (b.cat ?? "reg") === "new";
          if (isNew) r.nNew++;
          const cls = await classifyLikeAsk(b.text, state);
          const fin = finalizeAskAnswer(b.text, {
            dataText: b.text,
            question: q,
            execDangerSegments: cls.danger,
            execClassifierUnavailable: cls.unavailable,
            execConservativeVeto: cls.conservative,
          });
          const tag = `${b.id}/${kind}(gate=${cls.gate})`;
          if (fin.isolated) {
            r.isolated.push(tag);
            if (isNew) r.isolatedNew.push(tag);
          } else if (fin.changed) r.changed.push(tag);
          else if (fin.degraded) r.degradedOnly.push(tag);
          if (fin.answer.includes(INSTRUCTION_ISOLATED_MARK)) {
            r.instrIsolated.push(tag);
            if (isNew) r.instrIsolatedNew.push(tag);
          }
        }
      per[state] = r;
      writeFileSync("out/r309-benign-matrix.json", JSON.stringify(per, null, 1));
      console.log(
        `[benign/${state}] n=${r.n} isolated=${r.isolated.length} (${((r.isolated.length / r.n) * 100).toFixed(2)}%) instrIsolated=${r.instrIsolated.length} (${((r.instrIsolated.length / r.n) * 100).toFixed(2)}%) newIsolated=${r.isolatedNew.length}/${r.nNew}`
      );
    }, 280_000);
  }
});
