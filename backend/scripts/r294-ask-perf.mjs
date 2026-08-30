// R294 P2-4：生产 ask p50/p95 测量（修复前后对比）。
// 用 [QA-R296] 账号注册→写入少量笔记→重复问答→输出延迟分位数。
// 口令运行时随机生成，不落盘不提交。
const API = process.env.SUINIAN_API ?? "https://suinian-api.zalize.com";
const NAME = process.env.QA_NAME ?? `[QA-R296]perf-${Date.now().toString(36)}`;
const PASS = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);

const j = (r) => r.json();
const post = (path, body, token) =>
  fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const reg = await j(await post("/api/auth/register", { name: NAME, password: PASS }));
if (!reg.api_token) { console.error("register failed", reg); process.exit(1); }
const token = reg.api_token;
console.log("registered", reg.user.id, NAME);

const notes = [
  "今天花了 45 元买咖啡豆，浅烘的耶加雪菲",
  "周末想去爬山，记得带登山杖和水壶",
  "读完《置身事内》第三章，地方政府投融资那部分很有启发",
  "待办：下周三前把季度报告初稿发给老板",
  "灵感：做一个自动整理书签的小工具，按主题聚类",
];
for (const content of notes) await post("/api/notes", { content }, token);
await new Promise((r) => setTimeout(r, 2000));

// 每问都不同：绕开答案缓存，测的才是真实生成链路
const questions = [
  "我最近在想什么",
  "我最近花了哪些钱",
  "我的待办有哪些",
  "我读书有什么心得",
  "周末有什么计划",
  "咖啡相关的笔记有什么",
  "爬山要准备什么",
  "书里讲了什么内容",
  "季度报告什么时候交",
  "我记过什么工具灵感",
  "最近买过什么东西",
  "我有哪些没完成的事",
  "耶加雪菲是什么时候买的",
  "登山杖在哪条笔记里",
  "地方政府投融资我记了什么",
  "老板要的东西是什么",
  "书签工具的想法是什么",
  "我花钱买了什么喝的",
  "下周有什么安排",
  "我最近的灵感有哪些",
];
const N = Number(process.env.N ?? 20);
const lat = [];
for (let i = 0; i < N; i++) {
  const q = questions[i % questions.length];
  const t0 = Date.now();
  const r = await post("/api/ask", { question: q }, token);
  await r.text();
  const ms = Date.now() - t0;
  lat.push(ms);
  console.log(`#${i + 1} ${r.status} ${ms}ms ${q}`);
  await new Promise((r2) => setTimeout(r2, 1500));
}
lat.sort((a, b) => a - b);
const pct = (p) => lat[Math.min(lat.length - 1, Math.ceil((p / 100) * lat.length) - 1)];
console.log(`n=${lat.length} p50=${pct(50)}ms p95=${pct(95)}ms min=${lat[0]}ms max=${lat[lat.length - 1]}ms`);

// 注销并清理账号
const del = await fetch(`${API}/api/auth/me`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
console.log("account delete:", del.status);
