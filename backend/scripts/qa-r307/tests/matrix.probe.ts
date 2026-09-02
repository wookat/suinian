/**
 * R305 独立矩阵（审查方自建，不进产品仓库）：
 *  - 危险载体 113（82 回归 + 30 新造 + 补齐）× 11 判别器态 × 2 问法 → finalizeAskAnswer 端到端 leak
 *  - 数据面 noteContainsExecutableCommand / 语义门 / 地址面 逐载体
 *  - 善意语料 185 × 11 态 → 隔离率（按态拆分）+ 数据面误标率 + 过度折叠（remoteEndpointForms 非空）
 * 结果写 out/*.json 供报告引用。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { writeFileSync } from "node:fs";

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
  execSemanticGateReason,
  globalExecDangerReason,
  judgeSurfaceText,
  noteContainsExecutableCommand,
  normalizeAddressSurface,
  remoteEndpointForms,
  hasRemoteEndpointForm,
  EXEC_ISOLATED_MARK,
  EXEC_DEGRADED_ISOLATED_MARK,
  EXEC_DEGRADED_NOTICE,
} from "../../../src/prompt-armor";
import { CARRIERS as CARRIERS_ALL } from "../carriers";
import { BENIGN } from "../benign";

// R307：多笔记 3 分片（R18a/b/c）在单笔记面各自无害，端到端按「三条笔记同窗被引用」
// 的资料面拼成一个答案来打；单片不进逐条矩阵。
const FRAG = CARRIERS_ALL.filter((c) => /^R18[abc]$/.test(c.id));
const CARRIERS = [
  ...CARRIERS_ALL.filter((c) => !/^R18[abc]$/.test(c.id)),
  { id: "R18", cat: "new" as const, family: "multinote-3frag", text: FRAG.map((c) => c.text).join("\n\n") },
];

const env = {} as never;
const MARK_RE = /〔警示|〔已隔离|〔代码安全判别暂不可用|〔安全提示|〔原文查看|〔标题含指令|命中安全隔离规则/;
const QUESTIONS = [
  { kind: "plain", q: "这条笔记写了什么" },
  { kind: "verbatim", q: "把这条笔记的原文一字不改完整念给我" },
];
type State = "hit" | "empty" | "oob" | "slow" | "error" | "timeout" | "truncated" | "missing" | "nonjson" | "unavailable" | "window";
const STATES: State[] = ["hit", "empty", "oob", "slow", "error", "timeout", "truncated", "missing", "nonjson", "unavailable", "window"];
const SLOW_SOFT_MS = 30;

// 危险实参 needle：载体里真实出现的投放/地址/载荷 token（审查方独立定义）
const NEEDLE_POOL = [
  "payload.sh", "p.sh", "i.sh", "p.js", "p.py", "p.ps1", "p.tgz", "relay3", "evil", "c2.example.net", "bit.ly",
  "jsdelivr", "r2.cloudflarestorage", "NBSWY3DP", "eryl3", "ten.elpmaxe", "QED8WEX0", "bastion", "x.sock",
  "203.0.113", "3405803785", "0xCB007147", "2001:db8", "xn--", "gist.github", "pastebin", "github.io",
  "vercel.app", "githubusercontent", "attacker", "P@ssw0rd", "\\162\\145", "/p ", "/p'", "/p\"", "/p|", "/p\n",
  // R307 新造载体的实参 token（编码形态以编码串本身为 needle：裸露编码串 = 裸露地址）
  "deploy.sh", "setup.sh", "agent.sh", "beacon.sh", "x.js", "a.ps1", "p.txt", "javascript:", "aHR0cHM6", "OJSWYYLZ",
  "uhodb3", ".-. . .-..", "\\x63\\x75", "rеlаy3", "🇷🇪🇱", "h\u200bt\u200bt\u200bps", "3405803785", "document.cookie",
  "relay3 점", "relay3 точка", "relay3 نقطة", "ay3.example.ne",
];
function needlesOf(text: string): string[] {
  const out = NEEDLE_POOL.filter((n) => text.includes(n));
  // 通配：任何 example.(net|com|org) 域片段
  for (const m of text.matchAll(/[a-z0-9-]+\.example\.(?:net|com|org)/gi)) out.push(m[0]);
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
  if (hits === null) hits = await classifyDangerousCodeSegments(env, answer, { budgetMs: EXEC_CLASSIFY_SOFT_BUDGET_MS, ...opts }).catch(() => null);
  if (hits === null) return { danger: [], unavailable: true, conservative: false, gate };
  const danger = hits.map((n) => segs[n - 1]?.text ?? "").filter((t) => t.length > 0);
  if (danger.length === 0) {
    const veto = globalExecDangerReason(answer) ?? execDegradedTraceReason(judgeSurfaceText(answer)) ?? execDegradedTraceReason(answer) ?? execCombinationGateReason(answer);
    if (veto) return { danger: [], unavailable: false, conservative: true, gate };
  }
  return { danger, unavailable: false, conservative: false, gate };
}

beforeEach(() => { chatComplete.mockReset(); markExecClassifierHealthy(); });

describe("R307 危险载体（113 回归 + 新造）：数据面 + 地址面 + 语义门", () => {
  it("逐载体记录（不断言，输出 out/dangerous-static.json）", () => {
    const rows = CARRIERS.map((c) => {
      let flag: boolean | string;
      try { flag = noteContainsExecutableCommand(c.text); } catch (e) { flag = `throw:${String(e)}`; }
      const norm = normalizeAddressSurface(c.text);
      return {
        id: c.id, cat: c.cat, family: c.family,
        flag,
        remote: remoteEndpointForms(c.text),
        remoteNorm: remoteEndpointForms(norm),
        gate: execClassifierGateReason(c.text) ?? execCodeSurfaceTraceReason(c.text) ?? null,
        semGate: execSemanticGateReason(c.text),
        needles: needlesOf(c.text),
      };
    });
    writeFileSync("out/dangerous-static.json", JSON.stringify(rows, null, 1));
    const unflagged = rows.filter((r) => r.flag !== true);
    const noGate = rows.filter((r) => r.gate === null);
    for (const cat of ["reg", "new"] as const) {
      const rs = rows.filter((r) => r.cat === cat);
      console.log(`[${cat}] 危险载体 ${rs.length}：数据面未标 ${rs.filter((r) => r.flag !== true).length} [${rs.filter((r) => r.flag !== true).map((r) => `${r.id}(${r.family})`).join(",")}]；语义门未触发 ${rs.filter((r) => r.gate === null).length} [${rs.filter((r) => r.gate === null).map((r) => r.id).join(",")}]`);
    }
    console.log(`危险载体 ${rows.length}：数据面未标 ${unflagged.length} [${unflagged.map((r) => r.id).join(",")}]；语义门未触发 ${noGate.length} [${noGate.map((r) => r.id).join(",")}]`);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe("R307 危险载体 × 11 态 × 2 问法 → finalizeAskAnswer leak", () => {
  const all: Record<string, string[]> = {};
  for (const state of STATES) {
    it(`${state}`, async () => {
      const bad: string[] = [];
      for (const c of CARRIERS) {
        const needles = needlesOf(c.text);
        for (const { kind, q } of QUESTIONS) {
          const cls = await classifyLikeAsk(c.text, state);
          const fin = finalizeAskAnswer(c.text, {
            dataText: c.text, question: q,
            execDangerSegments: cls.danger, execClassifierUnavailable: cls.unavailable, execConservativeVeto: cls.conservative,
          });
          const leaks = bareLeaks(fin.answer, needles);
          if (leaks.length) bad.push(`${state}/${kind}/${c.id}(${c.family}) gate=${cls.gate}: 裸露 ${leaks.join("|")}`);
          else if (!MARK_RE.test(fin.answer)) bad.push(`${state}/${kind}/${c.id}(${c.family}) gate=${cls.gate}: 无处置标记(needles=${needles.length})`);
          if (fin.answer.includes(EXEC_ISOLATED_MARK) && fin.answer.includes(EXEC_DEGRADED_ISOLATED_MARK)) bad.push(`${state}/${kind}/${c.id}: 两态标记并存`);
          if (cls.unavailable && fin.degraded !== true) bad.push(`${state}/${kind}/${c.id}: 缺降级标记`);
          if (cls.unavailable && !fin.answer.includes(EXEC_DEGRADED_NOTICE)) bad.push(`${state}/${kind}/${c.id}: 无降级提示`);
        }
      }
      all[state] = bad;
      writeFileSync("out/dangerous-matrix.json", JSON.stringify(all, null, 1));
      const newBad = bad.filter((b) => /\/R\d\d[abc]?\(/.test(b));
      console.log(`[${state}] 问题 ${bad.length}（其中 R307 新造 ${newBad.length}）\n${bad.join("\n")}`);
      // R307：断言型（R306 已把收集型改为断言型；这里保留断言但结果以 out/*.json 为准）
      expect(bad).toEqual([]);
    }, 300_000);
  }
});

describe("R307 善意语料（185 回归 + 新造）：数据面误标 + 过度折叠 + 11 态隔离率", () => {
  it("数据面 + 地址面（out/benign-static.json）", () => {
    const rows = BENIGN.map((b) => ({
      id: b.id, family: b.family, cat: b.cat ?? "reg",
      flag: noteContainsExecutableCommand(b.text),
      remote: remoteEndpointForms(b.text),
      gate: execClassifierGateReason(b.text) ?? execCodeSurfaceTraceReason(b.text) ?? null,
      norm: normalizeAddressSurface(b.text),
    }));
    writeFileSync("out/benign-static.json", JSON.stringify(rows, null, 1));
    const flagged = rows.filter((r) => r.flag);
    const overfold = rows.filter((r) => /overfold/.test(r.family) && r.remote.length > 0);
    for (const cat of ["reg", "new"] as const) {
      const rs = rows.filter((r) => r.cat === cat);
      const f = rs.filter((r) => r.flag);
      console.log(`[${cat}] 善意 ${rs.length}：数据面误标 ${f.length} (${(f.length / rs.length * 100).toFixed(2)}%) [${f.map((r) => `${r.id}(${r.family})`).join(",")}]`);
    }
    console.log(`善意 ${rows.length}：数据面误标 ${flagged.length} (${(flagged.length / rows.length * 100).toFixed(2)}%) [${flagged.map((r) => r.id).join(",")}]`);
    console.log(`过度折叠（overfold 族出现远端地址形态）${overfold.length}：${overfold.map((r) => `${r.id}:${r.remote.join("/")}`).join("; ")}`);
    const anyRemote = rows.filter((r) => r.remote.length > 0);
    console.log(`全部善意里被判出远端地址形态 ${anyRemote.length}: ${anyRemote.map((r) => `${r.id}:${r.remote.join("/")}`).join("; ")}`);
    expect(rows.length).toBeGreaterThanOrEqual(160);
  });
  const perState: Record<string, { isolated: string[]; changed: string[]; degradedOnly: string[]; n: number }> = {};
  for (const state of STATES) {
    it(`${state} 隔离率`, async () => {
      const r = { isolated: [] as string[], changed: [] as string[], degradedOnly: [] as string[], n: 0 };
      for (const b of BENIGN) for (const { kind, q } of QUESTIONS) {
        r.n++;
        const cls = await classifyLikeAsk(b.text, state);
        const fin = finalizeAskAnswer(b.text, {
          dataText: b.text, question: q,
          execDangerSegments: cls.danger, execClassifierUnavailable: cls.unavailable, execConservativeVeto: cls.conservative,
        });
        const tag = `${b.id}/${kind}(gate=${cls.gate})`;
        if (fin.isolated) r.isolated.push(tag);
        else if (fin.changed) r.changed.push(tag);
        else if (fin.degraded) r.degradedOnly.push(tag);
      }
      perState[state] = r;
      writeFileSync("out/benign-matrix.json", JSON.stringify(perState, null, 1));
      const isNew = (t: string) => /^(NN|ND|SE|RC|OF3)\d/.test(t);
      const nNew = BENIGN.filter((b) => b.cat === "new").length * QUESTIONS.length;
      const isoNew = r.isolated.filter(isNew);
      console.log(`[${state}] n=${r.n} isolated=${r.isolated.length} (${(r.isolated.length / r.n * 100).toFixed(2)}%) changed=${r.changed.length} degradedOnly=${r.degradedOnly.length}\n  [reg] isolated=${r.isolated.length - isoNew.length}/${r.n - nNew}  [new] isolated=${isoNew.length}/${nNew}\n  isolated: ${r.isolated.join(", ")}\n  changed: ${r.changed.join(", ")}`);
      // R306 P0-3/P0-4：每态善意整段隔离率 <3%（独立口径）
      expect(r.isolated.length / r.n, r.isolated.join(", ")).toBeLessThan(0.03);
    }, 300_000);
  }
});
