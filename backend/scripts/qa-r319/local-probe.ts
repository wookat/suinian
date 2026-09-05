// R319 本地纯函数探针（不经模型，R318 副本）：R319 盲测（C01–C38）+ R317 盲测（B01–B36）+ R318 再族外（N01–N27）三套语料，
// 在「模型如实复述」最坏输入下量直答层（closeVerbatimForTier tier=single_note_direct + markDestructiveCommandLines）与
// 聚合层（closeAggregateVerbatim）的收口结果。判据口径与 qa-r317/local-probe.ts 一致，另加：
//   · direct_guarded：直答层「原样但带守卫」——答案含破坏警示行，或来源判为命令形态（broad:code/destructive/strict/fetch，
//     卡片与答案区复制都带守卫）。R318 把「原样无任何提醒」（literal && !guarded）作为破坏命令侧的漏网口径（decision-r318 §2.2）。
// 用法：npx tsx scripts/qa-r319/local-probe.ts [--json]
import { writeFileSync, mkdirSync } from "node:fs";
import {
  credentialValueTokens,
  destructiveCommandFamily,
  markDestructiveCommandLines,
  closeVerbatimForTier,
  finalizeAskAnswer,
  broadFoldReason,
} from "../../src/prompt-armor";
import { ALL as BLIND } from "../qa-r317/blind-carriers";
import { ALL as R318NEW } from "../qa-r318/new-carriers";
import { ALL as R319 } from "./blind-carriers";
import { ALL as INFORMED } from "./informed-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const hits = (ans: string, needles: string[]) => needles.filter((n) => (norm(n).length ? norm(ans).includes(norm(n)) : ans.includes(n)));
const DESTR_MARK = "〔警示：以下为破坏性命令";
const COMMAND_SHAPE = new Set(["strict", "broad:fetch", "broad:code", "broad:destructive"]);

type Row = {
  id: string; family: string; cat: string; seam: string | null; expect: string | null;
  fold_reason: string | null; destr_family: string | null; cred_tokens: string[];
  direct_answer: string; direct_survive: string[]; direct_warned: boolean; direct_guarded: boolean;
  agg_answer: string; agg_survive: string[];
};
const corpora = [["r319blind", R319], ["r319informed", INFORMED], ["r317blind", BLIND], ["r318new", R318NEW]] as const;
const all: Row[] = [];
for (const [corpus, items] of corpora) {
  const rows: Row[] = [];
  for (const c of items) {
    const units = c.texts;
    const direct = units[0];
    const tier = { kind: "single_note_direct", directUnit: direct } as unknown as Parameters<typeof closeVerbatimForTier>[1]["tier"];
    // R320：量生产同一出口 finalizeAskAnswer（含 R298 凭证断言拒答 + 分层收口），不再只量 closeVerbatimForTier 一层
    const d = finalizeAskAnswer(c.answer, { dataText: units.join("\n"), dataUnits: units, question: c.ask, tier });
    const dm = markDestructiveCommandLines(d.answer, units);
    const a = finalizeAskAnswer(c.answer, { dataText: units.join("\n"), dataUnits: units, question: c.ask });
    const fold = broadFoldReason(direct);
    const warned = dm.answer.includes(DESTR_MARK);
    rows.push({
      id: c.id, family: c.family, cat: c.cat, seam: c.seam ?? null, expect: (c as { expect?: string }).expect ?? null,
      fold_reason: fold, destr_family: destructiveCommandFamily(direct),
      cred_tokens: units.flatMap((u) => credentialValueTokens(u)),
      direct_answer: dm.answer, direct_survive: hits(dm.answer, c.needles), direct_warned: warned,
      direct_guarded: warned || (fold !== null && COMMAND_SHAPE.has(fold)),
      agg_answer: a.answer, agg_survive: hits(a.answer, c.needles),
    });
  }
  writeFileSync(`${OUT}/local-probe-${corpus}.json`, JSON.stringify(rows, null, 1));
  all.push(...rows);
  const danger = rows.filter((r) => r.cat === "danger");
  const cred = danger.filter((r) => /cred/.test(r.family));
  const destr = danger.filter((r) => /destructive/.test(r.family));
  const fmt = (rs: Row[], f: (r: Row) => string) => rs.map(f).join(" ");
  console.log(`\n== ${corpus}: danger=${danger.length} cred=${cred.length} destr=${destr.length} benign=${rows.length - danger.length}`);
  const credLeak = cred.filter((r) => r.direct_survive.length);
  console.log(`[cred/direct] literal=${credLeak.length}/${cred.length}: ${fmt(credLeak, (r) => `${r.id}[${r.direct_survive.join("|")}]`)}`);
  const credAgg = cred.filter((r) => r.agg_survive.length);
  console.log(`[cred/agg]    literal=${credAgg.length}/${cred.length}: ${fmt(credAgg, (r) => `${r.id}[${r.agg_survive.join("|")}]`)}`);
  console.log(`[cred] no token registered: ${cred.filter((r) => r.cred_tokens.length === 0).map((r) => r.id).join(",")}`);
  const noWarn = destr.filter((r) => r.direct_survive.length && !r.direct_warned);
  console.log(`[destr/direct] literal_no_warn=${noWarn.length}/${destr.length}: ${fmt(noWarn, (r) => `${r.id}[${r.destr_family ?? "-"}/${r.fold_reason ?? "-"}]`)}`);
  const noGuard = destr.filter((r) => r.direct_survive.length && !r.direct_guarded);
  console.log(`[destr/direct] literal_no_guard=${noGuard.length}/${destr.length}: ${fmt(noGuard, (r) => `${r.id}[${r.fold_reason ?? "-"}]`)}`);
  console.log(`[destr] family null: ${destr.filter((r) => !r.destr_family).map((r) => r.id).join(",")}`);
  const benign = rows.filter((r) => r.cat === "benign");
  const hurt = benign.filter((r) => r.direct_answer.includes("〔"));
  console.log(`[benign/direct] placeholder/mark inserted=${hurt.length}/${benign.length}: ${fmt(hurt, (r) => `${r.id}:${JSON.stringify(r.direct_answer).slice(0, 80)}`)}`);
  const benignFold = benign.filter((r) => r.fold_reason !== null && r.fold_reason !== "broad:code");
  console.log(`[benign] folded(non-code)=${benignFold.length}/${benign.length}: ${fmt(benignFold, (r) => `${r.id}[${r.fold_reason}]`)}`);
}
writeFileSync(`${OUT}/local-probe-all.json`, JSON.stringify(all, null, 1));
