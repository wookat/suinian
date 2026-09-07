// R328 D 本地引用归因矩阵（decision-r328 §4）：R327 全部 38 危险 + 44 善意载体作为同一账号的敏感笔记（全标注），
// 逐条用生产 ask 的确定性关键词（extractAskTerms，无 LLM 抽取）跑 recallSensitiveNotes，按 audit-r327 §5.3 口径分类：
//   exact = 引用卡全是自己那条；mixed = 自己 + 别人的；wrong = 有卡但没有自己的；none = 0 卡。
// 「旧口径」= 去掉 R328 的话题词剥离 / 主导命中（同一比对面），用于同一语料上的前后对比；生产 83 题数字另由 prod/ 脚本实测。
// 用法：npx tsx scripts/qa-r328/citation-matrix-local.ts
import { recallSensitiveNotes, sensitiveTermScore } from "../../src/sensitive-recall";
import { extractAskTerms } from "../../src/index";
import { askTopicTerms } from "../../src/ask";
import { DANGER, B } from "../qa-r327/blind-carriers";
import type { NoteRow } from "../../src/types";

const ALL = [...DANGER, ...B];
const rows: NoteRow[] = [];
const owner = new Map<string, string>();
let seq = 0;
for (const c of ALL) {
  for (const t of c.texts) {
    const id = `${c.id}-${seq++}`;
    owner.set(id, c.id);
    rows.push({
      id, user_id: "u1", source: "api", raw_type: "text", category: "data", tags: "[]", title: null, url: null, url_title: null,
      url_summary: null, url_titles: null, meta: null, is_sensitive: 1, todo_due: null, todo_done: 0, done_at: null, thread_id: null,
      content: t, content_enc: null, amount: null, currency: null,
      created_at: `2026-09-01 00:00:${String(seq % 60).padStart(2, "0")}`, updated_at: "2026-09-01 00:00:00", deleted_at: null,
    } as unknown as NoteRow);
  }
}
const env = {
  DB: {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }),
  } as unknown as D1Database,
};

type Cls = "exact" | "mixed" | "wrong" | "none";
function classify(ids: string[], self: string): Cls {
  if (ids.length === 0) return "none";
  const mine = ids.filter((id) => owner.get(id) === self).length;
  if (mine === ids.length) return "exact";
  return mine > 0 ? "mixed" : "wrong";
}

function oldRecall(terms: string[]): string[] {
  const topics = askTopicTerms(terms);
  const scored = rows
    .map((r) => ({ id: r.id, score: sensitiveTermScore(r.content ?? "", r.tags, terms, topics), created_at: r.created_at }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.created_at < b.created_at ? 1 : -1));
  return scored.slice(0, 5).map((s) => s.id);
}

// 生产里整句型 CJK 问句会走 LLM 关键词抽取（拆成实词 + 同义扩展），混引就是从这些拆出来的称谓词（密码 / 口令）来的。
// 本地无模型，用确定性近似：按虚词 / 标点切段，长段再取首尾二字。只用于前后对比，不代表生产数字。
const SIM_NOISE_RE = /(?:是多少|是什么|是啊|是哪个|是哪句|叫什么|多少|什么|哪个|哪些|怎么|如何|记得|还有|一下|来着|的话|现在|目前|如今|当前|最新|最近|之前|以前|上次|这次|后来|平时|帮我|直接|给我|就行|就好|一下|那个|这个|那条|这条|周|我的|我|你|请|帮|把|的|了|呢|吗|啊|嘛|呀|吧|是|在|有|就|都|也|还|很|不|能|要|会|到|去|来|让|用|看)/g;
function simKeywords(q: string): string[] {
  const segs = q.split(/[\s,，。？?！!、;；:：“”「」“”]+/).flatMap((s) => s.split(SIM_NOISE_RE));
  const out: string[] = [];
  for (const s0 of segs) {
    const s = s0.trim();
    if (s.length < 2) continue;
    if (!out.includes(s)) out.push(s);
    if (s.length > 4 && /^[\u4e00-\u9fff]+$/.test(s)) {
      for (const p of [s.slice(0, 2), s.slice(-2)]) if (!out.includes(p)) out.push(p);
    }
  }
  return out.slice(0, 8);
}

async function run(label: string, termsOf: (q: string, hist: Array<{ role: "user" | "assistant"; content: string }>) => string[]) {
  const tally = { old: { exact: 0, mixed: 0, wrong: 0, none: 0 }, new: { exact: 0, mixed: 0, wrong: 0, none: 0 } };
  const detail: string[] = [];
  let n = 0;
  for (const c of ALL) {
    const hist: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const q of c.asks) {
      n++;
      const terms = termsOf(q, hist);
      const o = classify(oldRecall(terms), c.id);
      const r = await recallSensitiveNotes(env, "u1", terms, { topicTerms: askTopicTerms(terms) });
      const nw = classify(r.rows.map((x) => x.id), c.id);
      tally.old[o]++;
      tally.new[nw]++;
      if (nw === "wrong" || nw === "mixed" || o !== nw) {
        detail.push(`${c.id} ${o}->${nw} q=${q} refs=${r.rows.map((x) => owner.get(x.id)).join(",")}`);
      }
      hist.push({ role: "user", content: q }, { role: "assistant", content: "" });
    }
  }
  console.log(`== ${label}: questions=${n}`);
  console.log("old(no strip/no dominance):", JSON.stringify(tally.old));
  console.log("new(R328 D):               ", JSON.stringify(tally.new));
  for (const d of detail) console.log(" ", d);
}

async function main() {
  await run("naive extractAskTerms", (q, hist) => extractAskTerms(q, hist));
  await run("simulated keyword extraction", (q, hist) => {
    const kw = simKeywords(q);
    const naive = extractAskTerms(q, hist);
    return [...kw, ...naive.filter((t) => !(/[\u4e00-\u9fff]/.test(t) && t.length >= 8))].filter((t, i, a) => a.indexOf(t) === i).slice(0, 8);
  });
}
main();
