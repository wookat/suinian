// P1-1 生产复测：/api/ask 答案缓存键须纳入 history / graph（audit-r305 §7 q205 串答）。
// 同文追问「分别是哪几笔？」在不同 history 下必须走各自的路径，不得命中彼此缓存。
// 用法：node prod/cache.mjs（自行注册 [QA-R310] 账号、写入资料、测完注销）
import { writeFileSync } from "node:fs";
import { req, register, postNote, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const acct = await register(`[QA-R310]cache-${Date.now().toString(36)}`);
const T = acct.token;
const notes = [
  "买书 《SICP》 花了 128 元",
  "买书 《TAOCP 卷一》 花了 236 元",
  "午饭 花了 38 元",
  "打车 花了 52 元",
  "买书 《算法导论》 花了 99 元",
];
const posted = [];
for (const n of notes) posted.push(await postNote(T, n));
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
rows.noHistory2 = await ask({ question: Q }); // 同键二次：应命中
// R309：写入新笔记后立即同问——R308 自报资料版本已入键，预期不命中旧答案
 const ddia = await postNote(T, "买书 《DDIA》 花了 150 元");
rows.afterWrite = await ask({ question: Q });
rows.afterWriteBooks = await ask({ question: Q, history: hBooks });
rows.afterWrite2 = await ask({ question: Q }); // 同版本二次：应命中
// R309：删除后立即同问
 const ddiaId = ddia.note?.id ?? ddia.id;
rows.delStatus = (await req(`/api/notes/${ddiaId}`, { method: "DELETE", token: T })).status;
rows.afterDelete = await ask({ question: Q });
// R309：编辑后立即同问（改金额 99→199）
 const algoId = posted[4].note?.id ?? posted[4].id;
rows.patchStatus = (await req(`/api/notes/${algoId}`, { method: "PATCH", token: T, body: { content: "买书 《算法导论》 花了 199 元" } })).status;
rows.afterPatch = await ask({ question: Q });
// verbatim 问法不是 body 参数而是由问句文本判定：不同问句天然不同键，这里记录两种问法不应互相命中
const QV = "把买书《SICP》那条笔记的原文一字不改完整念给我";
const QN = "买书《SICP》那条笔记写了什么";
rows.qn = await ask({ question: QN });
rows.qv = await ask({ question: QV });
rows.qv2 = await ask({ question: QV });

const hit = (r) => /anscache;desc=hit/.test(r.cache);
const summary = {
  version_probe: new Date().toISOString(),
  all1: { ms: rows.all1.ms, hit: hit(rows.all1), refs: rows.all1.refs, head: rows.all1.answer.slice(0, 80) },
  all2: { ms: rows.all2.ms, hit: hit(rows.all2), sameAsAll1: rows.all2.answer === rows.all1.answer },
  books: { ms: rows.books.ms, hit: hit(rows.books), refs: rows.books.refs, head: rows.books.answer.slice(0, 80), sameAsAll: rows.books.answer === rows.all1.answer },
  booksNoGraph: { ms: rows.booksNoGraph.ms, hit: hit(rows.booksNoGraph), sameAsBooks: rows.booksNoGraph.answer === rows.books.answer },
  noHistory: { ms: rows.noHistory.ms, hit: hit(rows.noHistory), sameAsAll: rows.noHistory.answer === rows.all1.answer },
  noHistory2: { ms: rows.noHistory2.ms, hit: hit(rows.noHistory2), sameAsNoHistory: rows.noHistory2.answer === rows.noHistory.answer },
  afterWrite: { ms: rows.afterWrite.ms, hit: hit(rows.afterWrite), sameAsNoHistory: rows.afterWrite.answer === rows.noHistory.answer, mentionsDDIA: rows.afterWrite.answer.includes("DDIA") || rows.afterWrite.answer.includes("150"), head: rows.afterWrite.answer.slice(0, 80) },
  afterWriteBooks: { ms: rows.afterWriteBooks.ms, hit: hit(rows.afterWriteBooks), sameAsBooks: rows.afterWriteBooks.answer === rows.books.answer, mentionsDDIA: rows.afterWriteBooks.answer.includes("DDIA") || rows.afterWriteBooks.answer.includes("150") },
  qn: { ms: rows.qn.ms, hit: hit(rows.qn), head: rows.qn.answer.slice(0, 80) },
  qv: { ms: rows.qv.ms, hit: hit(rows.qv), sameAsQn: rows.qv.answer === rows.qn.answer, head: rows.qv.answer.slice(0, 80) },
  qv2: { ms: rows.qv2.ms, hit: hit(rows.qv2), sameAsQv: rows.qv2.answer === rows.qv.answer },
  staleAfterWrite: hit(rows.afterWrite) || (rows.afterWrite.answer === rows.noHistory.answer && !rows.afterWrite.answer.includes("DDIA") && !rows.afterWrite.answer.includes("150")),
  afterWrite2: { ms: rows.afterWrite2.ms, hit: hit(rows.afterWrite2), sameAsAfterWrite: rows.afterWrite2.answer === rows.afterWrite.answer },
  afterDelete: { delStatus: rows.delStatus, ms: rows.afterDelete.ms, hit: hit(rows.afterDelete), stillMentionsDDIA: rows.afterDelete.answer.includes("DDIA") || rows.afterDelete.answer.includes("150"), head: rows.afterDelete.answer.slice(0, 80) },
  afterPatch: { patchStatus: rows.patchStatus, ms: rows.afterPatch.ms, hit: hit(rows.afterPatch), mentions199: rows.afterPatch.answer.includes("199"), still99: /\b99\b/.test(rows.afterPatch.answer), head: rows.afterPatch.answer.slice(0, 80) },
  cacheKeyPass: !hit(rows.books) && !hit(rows.booksNoGraph) && !hit(rows.noHistory) && rows.books.answer !== rows.all1.answer,
  booksSubsetClean: !rows.books.answer.includes("午饭") && !rows.books.answer.includes("打车"),
};
console.log(JSON.stringify(summary, null, 1));
writeFileSync(`${OUT}/prod-cache.json`, JSON.stringify({ summary, rows }, null, 1));

const del = await req("/api/auth/me", { method: "DELETE", token: T });
const after = await req("/api/auth/me", { token: T });
console.log("account deleted", del.status, "old token ->", after.status);
