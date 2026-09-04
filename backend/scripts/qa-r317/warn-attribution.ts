/**
 * R317：生产答案里出现的破坏命令警示行到底是「认出了这条命令」还是「同账号其它破坏笔记的操作对象碰巧同现」。
 * markDestructiveCommandLines(answer, sources) 的 sources 在生产是本次检索到的全部资料单元；fromSource 只要求
 * 「答案行含破坏动作词 ∧ 含任一来源破坏行的 ≥4 字操作对象」。这里把生产答案去掉警示行后分别用
 *   self  = 该载体自己的笔记文本
 *   all   = 该账号语料全部笔记文本
 * 重打一次，得出 self/cross 归因。只读产品函数，不改产品代码。
 * 用法：npx tsx scripts/qa-r317/warn-attribution.ts <label=blind|inf|r315>
 */
import { readFileSync } from "node:fs";
import { markDestructiveCommandLines, destructiveCommandFamily, DESTRUCTIVE_WARN_MARK } from "../../src/prompt-armor";

const label = process.argv[2] ?? "blind";
const OUT = new URL("./out", import.meta.url).pathname;
const corpusName = label === "inf" ? "informed" : label;
type C = { id: string; texts: string[]; cat: string };
type Row = { status: number; answer: string; trust_tier: string | null };
const corpus = JSON.parse(readFileSync(`${OUT}/${corpusName}.json`, "utf8")) as C[];
const rows = JSON.parse(readFileSync(`${OUT}/prod-ask-${label}.json`, "utf8")) as Record<string, Record<string, Row>>;
const all = corpus.flatMap((c) => c.texts);
const strip = (a: string) => a.split("\n").filter((l) => l !== DESTRUCTIVE_WARN_MARK).join("\n");

let warned = 0, self = 0, crossOnly = 0, neither = 0;
const lines: string[] = [];
for (const c of corpus) {
  if (c.cat !== "danger") continue;
  const R = rows[c.id];
  if (!R) continue;
  for (const [k, v] of Object.entries(R)) {
    if (!v || v.status !== 200 || !v.answer.includes(DESTRUCTIVE_WARN_MARK)) continue;
    warned++;
    const bare = strip(v.answer);
    const bySelf = markDestructiveCommandLines(bare, c.texts).count > 0;
    const byAll = markDestructiveCommandLines(bare, all).count > 0;
    const trig = bySelf ? [] : corpus.filter((o) => o.id !== c.id && markDestructiveCommandLines(bare, o.texts).count > 0).map((o) => o.id);
    const tag = bySelf ? "self" : byAll ? `cross-only(${trig.join(",")})` : "neither(model?)";
    if (bySelf) self++; else if (byAll) crossOnly++; else neither++;
    lines.push(`${c.id}/${k}\tfamily=${destructiveCommandFamily(c.texts.join("\n")) ?? "null"}\t${tag}`);
  }
}
console.log(`== ${label}: warned_rows=${warned} self=${self} cross_only=${crossOnly} neither=${neither}`);
for (const l of lines) console.log(l);
