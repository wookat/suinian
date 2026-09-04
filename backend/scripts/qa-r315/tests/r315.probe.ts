/**
 * R315 本地探针（测量型，不断言产品行为）：直调 R314 合并态（main 95b26b9）的收口函数，
 * 以「模型如实复述」（carriers.answer）为最坏输入，量三组读实现语料在两个信任域下的存活。
 *
 *  · P01（白名单/资料排除/切窗）× {aggregate, single_note_direct}
 *  · P02（凭证泛化 / 破坏命令变体）× {aggregate, single_note_direct} + 折叠判据 + 警示行
 *  · ECHO（问句豁免）× single_note_direct（exemptText=ask）与 aggregate
 *  · BENIGN 30 × single_note_direct：可用性（answer 是否被整句抹掉）
 *  · maskSystemMarks 单元行为：整串/变体/资料排除
 *
 * 口径：survive = needles 归一化子串命中（任意危险片段）；lcs8 = 答案（去占位）与来源归一化最长公共串 ≥8。
 * 输出 out/probe.json + out/probe.txt。
 */
import { it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  finalizeAskAnswer,
  closeAggregateVerbatim,
  closeVerbatimForTier,
  maskSystemMarks,
  broadFoldReason,
  defaultFoldedReason,
  credentialValueTokens,
  isDestructiveCommandText,
  markDestructiveCommandLines,
  AGGREGATE_TIER,
  type TrustTier,
} from "../../../src/prompt-armor";
import { P01, P02, ECHO, BENIGN, type Carrier } from "../carriers";

const OUT = new URL("../out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const PH_RE = /〔[^〕]*〕/g;
const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const hits = (ans: string, needles: string[]): string[] =>
  needles.filter((n) => (norm(n).length ? norm(ans).includes(norm(n)) : ans.includes(n)));
/** 拼接口径（审查方自定义启发式）：把答案里的 ASCII 字母数字段按序拼接（丢掉单个孤立字母，保留单个数字），
 * 再看 needle 是否成为子串——量「切窗 / 逐位 / 分段」形态下人眼可直接拼回的取值。 */
const reassembled = (ans: string): string =>
  (ans.replace(PH_RE, "").normalize("NFKC").match(/[A-Za-z0-9]+/g) ?? []).filter((r) => !(r.length === 1 && /[A-Za-z]/.test(r))).join("").toLowerCase();
const rehits = (ans: string, needles: string[]): string[] =>
  needles.filter((n) => /^[A-Za-z0-9]+$/.test(n.normalize("NFKC")) && n.length >= 5 && reassembled(ans).includes(n.normalize("NFKC").toLowerCase()));
function lcsLen(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev = new Uint16Array(b.length + 1);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Uint16Array(b.length + 1);
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++)
      if (ca === b.charCodeAt(j - 1)) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    prev = cur;
  }
  return best;
}
const lcs8 = (ans: string, texts: string[]): number => Math.max(0, ...texts.map((t) => lcsLen(norm(ans.replace(PH_RE, "")), norm(t))));
const meaningful = (s: string): number => norm(s.replace(PH_RE, "").replace(/\[\d+\]/g, "")).length;

type Row = {
  id: string; family: string; seam?: string; tier: string;
  before_survive: string[]; after: string; survive: string[]; reassembled: string[]; lcs8: number; count: number; aggregate?: number;
  fold_reason: string | null; default_folded: boolean; cred_tokens: string[]; useful: boolean; destructive_marked?: boolean;
};

function run(c: Carrier, tier: TrustTier, exempt?: string): Row {
  const units = c.texts;
  const r = tier.kind === "aggregate"
    ? (() => { const x = closeAggregateVerbatim(c.answer, units); return { answer: x.answer, count: x.count, aggregate: x.count }; })()
    : closeVerbatimForTier(c.answer, { units, tier, exemptText: exempt });
  const after = markDestructiveCommandLines(r.answer).answer;
  const fr = broadFoldReason(c.texts[0]);
  return {
    id: c.id, family: c.family, seam: c.seam, tier: tier.kind,
    before_survive: hits(c.answer, c.needles), after, survive: hits(after, c.needles), reassembled: rehits(after, c.needles), lcs8: lcs8(after, units),
    count: r.count, aggregate: r.aggregate, fold_reason: fr, default_folded: defaultFoldedReason(fr),
    cred_tokens: units.flatMap((u) => credentialValueTokens(u)),
    useful: meaningful(after) >= Math.min(8, Math.floor(meaningful(c.answer) * 0.5)),
    destructive_marked: /〔警示：以下为破坏性命令/.test(after),
  };
}

const lines: string[] = [];
const L = (s: string): void => { lines.push(s); console.log(s); };
const rows: Record<string, Row[]> = {};

function section(name: string, cs: Carrier[], tiers: Array<"agg" | "direct">, withExempt = false): void {
  rows[name] = [];
  for (const c of cs) {
    for (const t of tiers) {
      const tier: TrustTier = t === "agg" ? AGGREGATE_TIER : { kind: "single_note_direct", directUnit: c.texts[0] };
      rows[name].push(run(c, tier, withExempt && t === "direct" ? c.ask : undefined));
    }
  }
  for (const t of tiers) {
    const rs = rows[name].filter((r) => r.tier === (t === "agg" ? "aggregate" : "single_note_direct"));
    const danger = rs.filter((r) => cs.find((c) => c.id === r.id)?.cat === "danger");
    const surv = danger.filter((r) => r.survive.length);
    const l8 = danger.filter((r) => r.lcs8 >= 8);
    const re = danger.filter((r) => r.reassembled.length && !r.survive.length);
    const benign = rs.filter((r) => cs.find((c) => c.id === r.id)?.cat === "benign");
    const useless = benign.filter((r) => !r.useful);
    L(`[${name}/${t}] danger n=${danger.length} survive(any-fragment)=${surv.length} lcs8>=8=${l8.length} reassembled-only=${re.length}${re.length ? `(${re.map((r) => r.id).join(",")})` : ""}` +
      (benign.length ? ` | benign n=${benign.length} useless=${useless.length}` : ""));
    if (surv.length) L(`   survive: ${surv.map((r) => `${r.id}[${r.survive.join("|")}]`).join(" ")}`);
    if (useless.length) L(`   useless: ${useless.map((r) => r.id).join(" ")}`);
  }
}

it("P01 whitelist/exclusion/split", () => {
  section("P01", P01, ["agg", "direct"]);
  for (const r of rows.P01) L(`  ${r.id} ${r.tier.padEnd(18)} fold=${r.fold_reason} survive=[${r.survive.join("|")}] lcs8=${r.lcs8} count=${r.count} :: ${r.after.replace(/\n/g, "⏎").slice(0, 110)}`);
});

it("maskSystemMarks unit behaviour", () => {
  const PH = "〔原文片段略，见引用笔记卡片〕";
  const cases: Array<[string, string, string[]]> = [
    ["exact whole, no unit has it", `a ${PH} b`, []],
    ["exact whole, unit has it (exclusion)", `a ${PH} b`, [`${PH}口令 x`]],
    ["fullwidth comma variant", "a 〔原文片段略，见引用笔记卡片 〕 b", []],
    ["inner space variant", "a 〔原文片段略， 见引用笔记卡片〕 b", []],
    ["two marks", `${PH}x${PH}`, []],
    ["sentinel injected by data (spoof)", "a \uE000\uE100 b", []],
  ];
  L("[maskSystemMarks]");
  for (const [name, ans, units] of cases) {
    const m = maskSystemMarks(ans, units);
    L(`  ${name}: masked=${m.masked !== ans} maskedText=${JSON.stringify(m.masked)} restore_roundtrip=${m.restore(m.masked) === ans.replace(/\uE000[\uE100-\uE1FF]/g, "")}`);
  }
});

it("P02 credential/destructive", () => {
  section("P02", P02, ["agg", "direct"]);
  for (const r of rows.P02.filter((r) => r.tier === "single_note_direct"))
    L(`  ${r.id} fold=${r.fold_reason} cred=[${r.cred_tokens.join("|")}] survive=[${r.survive.join("|")}] destructive_marked=${r.destructive_marked} isDestructive=${isDestructiveCommandText(P02.find((c) => c.id === r.id)!.texts[0])} :: ${r.after.replace(/\n/g, "⏎").slice(0, 100)}`);
});

it("ECHO question exemption", () => {
  section("ECHO", ECHO, ["direct", "agg"], true);
  for (const r of rows.ECHO) {
    const c = ECHO.find((x) => x.id === r.id)!;
    const inQ = r.survive.filter((n) => norm(c.ask).includes(norm(n)));
    const notInQ = r.survive.filter((n) => !norm(c.ask).includes(norm(n)));
    L(`  ${r.id} ${r.tier.padEnd(18)} survive=[${r.survive.join("|")}] echo_only=[${inQ.join("|")}] note_leak=[${notInQ.join("|")}] :: ${r.after.replace(/\n/g, "⏎").slice(0, 100)}`);
  }
  // 无豁免对照
  const noEx = ECHO.filter((c) => c.cat === "danger").map((c) => run(c, { kind: "single_note_direct", directUnit: c.texts[0] }));
  L(`[ECHO/direct no-exempt control] survive=${noEx.filter((r) => r.survive.length).length}/${noEx.length}`);
});

it("BENIGN 30 usability (direct)", () => {
  section("BENIGN", BENIGN, ["direct", "agg"]);
  const fp = BENIGN.map((c) => ({ id: c.id, fold: broadFoldReason(c.texts[0]) })).filter((x) => x.fold !== null);
  L(`  benign fold false-positives: ${fp.length}/${BENIGN.length} ${fp.map((x) => `${x.id}[${x.fold}]`).join(" ")}`);
});

it("finalizeAskAnswer end-to-end (direct, with question)", () => {
  const out: string[] = [];
  for (const c of [...P01, ...P02, ...ECHO]) {
    const tier: TrustTier = { kind: "single_note_direct", directUnit: c.texts[0] };
    const fin = finalizeAskAnswer(c.answer, { dataText: c.texts.join("\n"), dataUnits: c.texts, question: c.ask, verbatimExempt: c.ask, tier });
    const s = hits(fin.answer, c.needles);
    out.push(`  ${c.id} survive=[${s.join("|")}] reason=${fin.reason ?? "-"} :: ${fin.answer.replace(/\n/g, "⏎").slice(0, 90)}`);
  }
  L("[finalizeAskAnswer/direct]");
  for (const s of out) L(s);
  writeFileSync(`${OUT}/probe.json`, JSON.stringify(rows, null, 1));
  writeFileSync(`${OUT}/probe.txt`, lines.join("\n") + "\n");
});
