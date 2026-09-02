// P1-1 生产复测：/api/ask 答案缓存键须纳入 history / graph（audit-r305 §7 q205 串答）。
// 同文追问「分别是哪几笔？」在不同 history 下必须走各自的路径，不得命中彼此缓存。
// 用法：node prod/cache.mjs（自行注册 [QA-R306] 账号、写入资料、测完注销）
import { writeFileSync } from "node:fs";
import { req, register, postNote, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const acct = await register(`[QA-R306]cache-${Date.now().toString(36)}`);
const T = acct.token;
const notes = [
  "买书 《SICP》 花了 128 元",
  "买书 《TAOCP 卷一》 花了 236 元",
  "午饭 花了 38 元",
  "打车 花了 52 元",
  "买书 《算法导论》 花了 99 元",
];
for (const n of notes) await postNote(T, n);
await sleep(20000);

async function ask(body) {
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    const r = await req("/api/ask", { method: "POST", token: T, body });
    if (r.status === 429) {
      await sleep(20000);
      continue;
    }
    return {
      status: r.status,
      ms: Date.now() - t0,
      cache: r.headers.get("server-timing") ?? "",
      answer: r.json?.answer ?? r.text.slice(0, 200),
      refs: (r.json?.references ?? []).length,
    };
  }
  return { status: 429 };
}

const Q = "分别是哪几笔？";
const hBooks = [
  { role: "user", content: "今年买书一共花了多少" },
  { role: "assistant", content: "按关键词「买书」精确匹配（标题/正文/标签），今年共 3 笔支出：\n- CNY：支出 ¥463\n\n以上为数据库精确统计（关键词匹配口径，金额口径与周报/月报一致，不含已删除笔记）。" },
];
const hAll = [
  { role: "user", content: "我一共花了多少钱" },
  { role: "assistant", content: "到目前为止你共记了 5 笔支出：\n- CNY：支出 ¥553\n\n以上为数据库精确统计（金额口径与周报/月报一致，不含已删除笔记）。" },
];
const rows = {};
rows.all1 = await ask({ question: Q, history: hAll });
rows.all2 = await ask({ question: Q, history: hAll }); // 同 history 二次：允许命中缓存
rows.books = await ask({ question: Q, history: hBooks }); // 不同 history：不得命中 all 的缓存
rows.booksNoGraph = await ask({ question: Q, history: hBooks, graph: false }); // graph 参数不同：独立键
rows.noHistory = await ask({ question: Q });

const hit = (r) => /anscache;desc=hit/.test(r.cache);
const summary = {
  version_probe: new Date().toISOString(),
  all1: { ms: rows.all1.ms, hit: hit(rows.all1), refs: rows.all1.refs, head: rows.all1.answer.slice(0, 80) },
  all2: { ms: rows.all2.ms, hit: hit(rows.all2), sameAsAll1: rows.all2.answer === rows.all1.answer },
  books: { ms: rows.books.ms, hit: hit(rows.books), refs: rows.books.refs, head: rows.books.answer.slice(0, 80), sameAsAll: rows.books.answer === rows.all1.answer },
  booksNoGraph: { ms: rows.booksNoGraph.ms, hit: hit(rows.booksNoGraph), sameAsBooks: rows.booksNoGraph.answer === rows.books.answer },
  noHistory: { ms: rows.noHistory.ms, hit: hit(rows.noHistory), sameAsAll: rows.noHistory.answer === rows.all1.answer },
  cacheKeyPass: !hit(rows.books) && !hit(rows.booksNoGraph) && !hit(rows.noHistory) && rows.books.answer !== rows.all1.answer,
  booksSubsetClean: !rows.books.answer.includes("午饭") && !rows.books.answer.includes("打车"),
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(`${OUT}/prod-cache.json`, JSON.stringify({ summary, rows }, null, 1));

const del = await req("/api/auth/me", { method: "DELETE", token: T });
const after = await req("/api/auth/me", { token: T });
console.log("account deleted", del.status, "old token ->", after.status);
