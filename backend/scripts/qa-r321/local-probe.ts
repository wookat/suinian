// R321 本地纯函数探针（不经模型；R319 local-probe 同口径，只换语料）：R321 盲测 G/GB + 预言机 O + 读实现后 informed（若存在），
// 在「模型如实复述」最坏输入下量生产同一出口 finalizeAskAnswer（直答 tier=single_note_direct / 聚合）的收口结果；
// 另列 directGuardLines(unit) 对每条源笔记判出的结构面（哪些行、什么类别）——用于回答「判定入口覆盖面」。
// 口径：survive = needles 归一化子串命中；guarded = 直答含破坏警示或来源判为命令形态；
//       benign hurt = 直答被插入任何〔…〕占位/标记。
// 用法：npx tsx scripts/qa-r321/local-probe.ts
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { markDestructiveCommandLines, finalizeAskAnswer, broadFoldReason, directGuardLines } from "../../src/prompt-armor";
import { ALL as BLIND } from "./blind-carriers";
import { ORACLE } from "./oracle-carriers";

const OUT = new URL("./out", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const hits = (ans: string, needles: string[]) => needles.filter((n) => (norm(n).length ? norm(ans).includes(norm(n)) : ans.includes(n)));
const DESTR_MARK = "〔警示：以下为破坏性命令";
const COMMAND_SHAPE = new Set(["strict", "broad:fetch", "broad:code", "broad:destructive"]);

type C = { id: string; family: string; cat: string; seam?: string; expect?: string; tier?: string; texts: string[]; answer: string; needles: string[]; ask: string };
type Row = {
  id: string; family: string; cat: string; tier: string | null; seam: string | null; expect: string | null;
  fold_reason: string | null; guard_lines: string[];
  direct_answer: string; direct_survive: string[]; direct_warned: boolean; direct_guarded: boolean; direct_marked: boolean;
  agg_answer: string; agg_survive: string[];
};
const oracleAsC: C[] = ORACLE.map((o) => ({ id: o.id, family: o.family, cat: "danger", texts: [o.text], answer: `${o.subject}是 ${o.secret}[1]。`, needles: [o.secret], ask: o.ask, seam: o.shape }));
const corpora: [string, C[]][] = [["r321blind", BLIND as C[]], ["r321oracle", oracleAsC]];
if (existsSync(new URL("./informed-carriers.ts", import.meta.url))) {
  const m = await import("./informed-carriers");
  corpora.push(["r321informed", m.ALL as C[]]);
}
for (const [corpus, items] of corpora) {
  const rows: Row[] = [];
  for (const c of items) {
    const units = c.texts;
    const direct = units[0];
    const tier = { kind: "single_note_direct", directUnit: direct } as unknown as Parameters<typeof closeVerbatimForTierT>[1];
    const d = finalizeAskAnswer(c.answer, { dataText: units.join("\n"), dataUnits: units, question: c.ask, tier: tier as never });
    const dm = markDestructiveCommandLines(d.answer, units);
    const a = finalizeAskAnswer(c.answer, { dataText: units.join("\n"), dataUnits: units, question: c.ask });
    const fold = broadFoldReason(direct);
    const warned = dm.answer.includes(DESTR_MARK);
    const gl = units.flatMap((u, i) => directGuardLines(u).map((g) => `#${i}:${g.kind}${g.own ? "" : "(!own)"}:${g.line.slice(0, 30)}`));
    rows.push({
      id: c.id, family: c.family, cat: c.cat, tier: c.tier ?? null, seam: c.seam ?? null, expect: c.expect ?? null,
      fold_reason: fold, guard_lines: gl,
      direct_answer: dm.answer, direct_survive: hits(dm.answer, c.needles), direct_warned: warned,
      direct_guarded: warned || (fold !== null && COMMAND_SHAPE.has(fold)), direct_marked: dm.answer.includes("〔"),
      agg_answer: a.answer, agg_survive: hits(a.answer, c.needles),
    });
  }
  writeFileSync(`${OUT}/local-probe-${corpus}.json`, JSON.stringify(rows, null, 1));
  const danger = rows.filter((r) => r.cat === "danger");
  const fmt = (rs: Row[], f: (r: Row) => string) => rs.map(f).join(" ");
  console.log(`\n== ${corpus}: danger=${danger.length} benign=${rows.length - danger.length}`);
  const noGuardLine = danger.filter((r) => r.guard_lines.length === 0);
  console.log(`[danger] directGuardLines 判出结构面=${danger.length - noGuardLine.length}/${danger.length}; 无任何结构面（判定入口外）: ${noGuardLine.map((r) => r.id).join(",")}`);
  const dl = danger.filter((r) => r.direct_survive.length);
  console.log(`[danger/direct] survive=${dl.length}/${danger.length}: ${fmt(dl, (r) => `${r.id}[${r.direct_survive.join("|")}]${r.direct_warned ? "WARN" : ""}`)}`);
  const al = danger.filter((r) => r.agg_survive.length);
  console.log(`[danger/agg]    survive=${al.length}/${danger.length}: ${fmt(al, (r) => `${r.id}[${r.agg_survive.join("|")}]`)}`);
  const benign = rows.filter((r) => r.cat === "benign");
  for (const t of ["plain", "tech", null]) {
    const bs = benign.filter((r) => r.tier === t);
    if (!bs.length) continue;
    const hurt = bs.filter((r) => r.direct_marked);
    console.log(`[benign/${t ?? "-"}/direct] marked=${hurt.length}/${bs.length}: ${fmt(hurt, (r) => `${r.id}:${JSON.stringify(r.direct_answer).slice(0, 70)}`)}`);
    const aggHurt = bs.filter((r) => r.agg_answer.includes("〔"));
    console.log(`[benign/${t ?? "-"}/agg]    marked=${aggHurt.length}/${bs.length}: ${aggHurt.map((r) => r.id).join(",")}`);
  }
}
type closeVerbatimForTierT = (a: string, o: { tier: unknown }) => unknown;
