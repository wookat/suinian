/**
 * R268 retrieval-eval：检索召回可复跑评测套件（docs/decision-r268.md §2，audit-r267 P1-2）。
 *
 * 用法：
 *   SUINIAN_API_BASE=https://suinian-api.zalize.com npx tsx scripts/retrieval-eval.ts \
 *     [--only=q01,q05] [--keep] [--out=res.json]
 *
 * 目的：把「关键词抽取正则流水线导致的系统性召回缺口」从个案叙述变成可量化指标。
 * 方法：
 *  - 独立 [QA-R308] 账号，导入固定语料（每条一个 key），等 embedding/金额就绪；
 *  - 每个问题记：是否召回到期望笔记（recall）、引用集里期望笔记占比（precision）、
 *    是否落入「精确匹配没有找到」型确定性零命中（failClosed）、答案是否含期望文字、
 *    以及是否回显了垃圾关键词（regexLeak，audit-r267 P1-2 的用户可见症状）；
 *  - 汇总 recall/precision/零命中率/延迟 p50-p95，退出码 1 = 有必过题未过（回归门）。
 *
 * 语料与问题覆盖 audit-r267 明确要求的 case：R265 benign 未召回 2 例（R01/R02）、
 * q31 依据类、历史召回 case（余额宝/逐笔/书上/从 X 转出/谁给我）。
 */

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const KEEP = process.argv.includes("--keep");
const OUT = (process.argv.find((a) => a.startsWith("--out=")) ?? "").replace("--out=", "");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").replace("--only=", "").split(",").filter(Boolean);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let token = process.env.SUINIAN_TOKEN ?? "";
let createdAccount = false;
let accountName = "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
    });
    if ((res.status === 429 || res.status === 409) && attempt < 4) {
      const wait = res.status === 429 ? 65_000 * (attempt + 1) : 2_000 * (attempt + 1);
      console.log(`  ${res.status} on ${path}，${wait / 1000}s 后重试`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

interface EvalNote {
  key: string;
  content: string;
  category: "expense" | "income" | "transfer" | "idea" | "todo" | "collect" | "data";
  tags?: string[];
}

/** 语料：措辞与提问故意不成子串关系（这正是 audit-r267 P1-2 的缺口形态）。 */
const NOTES: EvalNote[] = [
  { key: "salary", content: "公司发了 8 月工资 18500 元，已到账。", category: "income", tags: ["工资"] },
  { key: "zhang-transfer", content: "张伟微信转我 600 元，是上次代付的电影票钱。", category: "income", tags: ["代付"] },
  { key: "mom-transfer", content: "妈妈打过来 2000 元，让我买身衣服。", category: "income", tags: ["家人"] },
  { key: "refund", content: "淘宝退款到账 129 元。", category: "income", tags: ["退款"] },
  { key: "yuebao-out", content: "从余额宝取出 5000 元到银行卡。", category: "transfer", tags: ["余额宝"] },
  { key: "yuebao-in", content: "工资到账后转进余额宝 3000 元。", category: "transfer", tags: ["余额宝"] },
  { key: "book-1", content: "买了本《人类简史》，78 元。", category: "expense", tags: ["书"] },
  { key: "book-2", content: "在旧书店淘到两本二手小说，一共 36 元。", category: "expense", tags: ["书"] },
  { key: "coffee", content: "楼下咖啡 28 元。", category: "expense", tags: ["咖啡"] },
  { key: "rent", content: "交房租 3200 元。", category: "expense", tags: ["房租"] },
  { key: "grocery", content: "菜市场买菜 63 元。", category: "expense", tags: ["买菜"] },
  { key: "dentist", content: "预约周五 15:00 牙科复诊，记得带社保卡。", category: "todo", tags: ["就医"] },
  { key: "filter", content: "手冲用的滤纸 V60 比蛋糕杯更适合浅烘，回头换一批。", category: "idea", tags: ["咖啡"] },
  { key: "sqlite", content: "读到一篇讲 SQLite 单文件数据库设计取舍的文章，值得再看一遍。", category: "collect", tags: ["数据库"] },
  // ---- R270 扩充：R269 独立召回集的失败/精确率 case（audit-r269 §5）----
  { key: "dehumid", content: "回南天太潮了，考虑买个除湿机放卧室。", category: "idea", tags: ["家电"] },
  { key: "product-idea", content: "产品点子：给碎念做一个「一句话回顾昨天」的每日卡片。", category: "idea", tags: ["点子"] },
  { key: "sprint", content: "sprint review 定在周四下午三点，准备演示稿。", category: "todo", tags: ["工作"] },
  { key: "catfood", content: "고양이 사료 45000원에 샀다.", category: "expense", tags: ["宠物"] },
  { key: "travel-list", content: "旅行清单：充电器、雨伞、防晒霜、耳塞。", category: "data", tags: ["旅行"] },
  { key: "gym", content: "办了健身房年卡 1980 元，每周去三次。", category: "expense", tags: ["健身"] },
  // ---- R274 扩充：audit-r273 §四 R18（检出正确笔记却按错误改写意图作答）----
  { key: "okr", content: "季度 OKR：首屏 LCP 目标 2.5 秒以内，接口错误率低于 0.1%。", category: "data", tags: ["OKR"] },
];

interface EvalQuery {
  id: string;
  question: string;
  /** 期望召回到的笔记 key（命中任一即算召回） */
  expectAny: string[];
  /** 期望全部召回（相关性完整度，如「逐笔列出收入」） */
  expectAll?: string[];
  /** 该题在 audit-r267 / audit-r265 中的出处 */
  origin: string;
  /** 必过题（进回归门）；false = 观察题，只进报告 */
  gate?: boolean;
  /** 答案里必须出现的文字（金额等） */
  expectAnswerContains?: string[];
}

const QUERIES: EvalQuery[] = [
  // audit-r267 P1-2 本地复现的 5 个坑词 case
  { id: "q01", question: "钱是别人打给我的有哪几笔？", expectAny: ["zhang-transfer", "mom-transfer"], origin: "audit-r267 P1-2（terms=[钱是别人打给]）", gate: true },
  { id: "q02", question: "有哪些收入是别人转给我的？", expectAny: ["zhang-transfer", "mom-transfer"], origin: "audit-r267 P1-2（terms=[是别人转给]）", gate: true },
  { id: "q03", question: "把我的收入逐笔列出来", expectAll: ["salary", "zhang-transfer", "mom-transfer", "refund"], expectAny: ["salary"], origin: "audit-r267 P1-2（terms=[逐]）", gate: true },
  { id: "q04", question: "书上花了多少钱", expectAny: ["book-1", "book-2"], origin: "audit-r267 P1-2（terms=[书上]）", gate: true },
  { id: "q05", question: "从余额宝转出的有几笔", expectAny: ["yuebao-out"], origin: "audit-r267 P1-2 / F28（terms=[从宝转出]）", gate: true },
  { id: "q06", question: "从余额宝转出过多少钱", expectAny: ["yuebao-out"], origin: "audit-r267 §6 F28", gate: true },
  // audit-r267 §6 R01/R02/R05 关系性问法（R265 benign 未召回 2 例同族）
  { id: "q07", question: "谁给我打过钱？", expectAny: ["zhang-transfer", "mom-transfer"], origin: "audit-r267 §6 R01（R265 benign 未召回）", gate: true },
  { id: "q08", question: "有人还我钱了吗", expectAny: ["zhang-transfer"], origin: "audit-r267 §6 R02（R265 benign 未召回）", gate: true },
  { id: "q09", question: "家里人给过我钱吗", expectAny: ["mom-transfer"], origin: "audit-r267 §6 R05", gate: true },
  // q31 依据类（audit-r267 P1-3）：必须给出引用而不是空答
  { id: "q10", question: "我这个月都花了哪些钱？依据是什么？", expectAny: ["rent", "grocery", "coffee", "book-1", "book-2"], origin: "audit-r267 P1-3（q31 依据类）", gate: true },
  // 历史召回 case：语义改写、非子串问法
  { id: "q11", question: "冲泡咖啡的滤纸器具哪个好", expectAny: ["filter"], origin: "ask-eval 历史语义召回探针", gate: true },
  { id: "q12", question: "我收藏过关于单文件数据库的文章吗", expectAny: ["sqlite"], origin: "历史召回 case（语义改写）", gate: true },
  { id: "q13", question: "看牙的事情安排在什么时候", expectAny: ["dentist"], origin: "历史召回 case（同义改写）", gate: true },
  { id: "q14", question: "读物方面的支出有多少", expectAny: ["book-1", "book-2"], origin: "历史召回 case（上位词）", gate: true },
  // 负控：确实没有的内容必须拒答，不许因语义放宽而编造
  { id: "q15", question: "我买过汽车吗？花了多少？", expectAny: [], origin: "负控（不得编造）", gate: true },
  // ---- R270 扩充：R269 独立召回集失败/精确率 case（audit-r269 §5）----
  { id: "q16", question: "潮", expectAny: ["dehumid"], origin: "audit-r269 §5 q11（单字长尾 0 召回）", gate: true },
  { id: "q17", question: "有什么产品点子吗？", expectAny: ["product-idea"], origin: "audit-r269 §5 q20（语义近邻误引 n23）", gate: true },
  { id: "q18", question: "When is the sprint review?", expectAny: ["sprint"], origin: "audit-r269 §5（跨语言召回）", gate: true },
  { id: "q19", question: "고양이 사료 얼마?", expectAny: ["catfood"], origin: "audit-r269 §5（跨语言召回）", gate: true },
  { id: "q20", question: "健身上花了多少钱", expectAny: ["gym"], origin: "audit-r269 §5（长尾短词）", gate: true },
  { id: "q21", question: "我的护照号是多少？", expectAny: [], origin: "audit-r269 §5 z02 负控（不得引用旅行清单）", gate: false },
  // ---- R274 扩充：audit-r273 §四 R18 —— 召回正确笔记后不得按改写意图答「没提到」
  { id: "q22", question: "本季度 OKR 的 LCP 目标是多少？", expectAny: ["okr"], expectAnswerContains: ["2.5"], origin: "audit-r273 §四 R18（改写意图错位）", gate: true },
];

const FAIL_CLOSED_RE = /精确匹配|没有找到|没有相关|未找到|找不到|没记过/;
/** 垃圾关键词回显（audit-r267 P1-2 的用户可见症状） */
const GARBAGE_TERMS = ["钱是别人打给", "是别人转给", "从宝转出", "书上", "逐"];

async function ensureAccount(): Promise<void> {
  if (token) return;
  accountName = `[QA-R308]retr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const res = await api<{ api_token: string; user: { id: string } }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: accountName, password: `Qa!${Math.random().toString(36).slice(2, 12)}A9` }),
  });
  token = res.api_token;
  createdAccount = true;
  console.log(`注册评测账号 ${res.user.id}（${accountName}）`);
}

async function destroyAccount(): Promise<void> {
  if (!createdAccount || KEEP) return;
  await api("/api/auth/me", { method: "DELETE" });
  const res = await fetch(`${API}/api/notes?limit=1`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status !== 401) throw new Error(`账号 ${accountName} 注销后旧 token 未失效：${res.status}`);
  console.log(`账号 ${accountName} 已注销，旧 token 401 已验证`);
}

async function seed(): Promise<Map<string, string>> {
  const idByKey = new Map<string, string>();
  for (const n of NOTES) {
    const r = await api<{ note: { id: string } }>("/api/notes", { method: "POST", body: JSON.stringify({ content: n.content }) });
    idByKey.set(n.key, r.note.id);
    await api(`/api/notes/${r.note.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: n.content, category: n.category, tags: n.tags ?? [] }),
    });
    await sleep(200);
  }
  console.log(`语料 ${NOTES.length} 条已写入并定分类`);
  return idByKey;
}

/** 等 embedding 就绪：用与任何笔记都不成子串关系的问法探针语义召回。 */
async function waitForEmbeddings(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const res = await api<{ notes: { match?: string }[] }>(`/api/notes?q=${encodeURIComponent("冲泡咖啡的滤纸器具哪个好")}&limit=20`);
    if ((res.notes ?? []).some((n) => n.match === "semantic" || n.match === "both")) {
      console.log(`embedding 就绪（约 ${(i + 1) * 3}s）`);
      return;
    }
  }
  console.warn("警告：语义探针始终未命中，embedding 可能未就绪（结果偏保守）");
}

/** 等金额分拣（财务类问答依赖 amount 列）。 */
async function waitForAmounts(idByKey: Map<string, string>): Promise<void> {
  const finKeys = NOTES.filter((n) => n.category === "expense" || n.category === "income").map((n) => n.key);
  for (let i = 0; i < 90; i++) {
    await sleep(5000);
    const res = await api<{ notes: { id: string; amount?: number | null }[] }>("/api/notes?limit=100");
    const byId = new Map(res.notes.map((n) => [n.id, n]));
    const missing = finKeys.filter((k) => byId.get(idByKey.get(k)!)?.amount == null);
    if (missing.length === 0) {
      console.log(`金额就绪（约 ${(i + 1) * 5}s）`);
      return;
    }
    if (i % 6 === 5) console.log(`  等待金额分拣：${missing.join(",")}`);
  }
  console.warn("警告：部分财务笔记未取到金额，财务类题可能偏差");
}

interface AskResponse {
  answer: string;
  references: { index: number; note_id: string }[];
  finance_fail_closed?: boolean;
  no_answer?: boolean;
}

interface QResult {
  id: string;
  question: string;
  origin: string;
  gate: boolean;
  refKeys: string[];
  recall: boolean;
  recallAll: boolean;
  precision: number;
  failClosed: boolean;
  regexLeak: string[];
  answerOk: boolean;
  pass: boolean;
  ms: number;
  answer: string;
}

async function runQuery(q: EvalQuery, idByKey: Map<string, string>): Promise<QResult> {
  const keyById = new Map([...idByKey.entries()].map(([k, v]) => [v, k]));
  const t0 = Date.now();
  const res = await api<AskResponse>("/api/ask", { method: "POST", body: JSON.stringify({ question: q.question }) });
  const ms = Date.now() - t0;
  const refKeys = res.references.map((r) => keyById.get(r.note_id) ?? `?${r.note_id.slice(0, 6)}`);
  const expected = new Set([...(q.expectAll ?? []), ...q.expectAny]);
  const recall = q.expectAny.length === 0 ? refKeys.length === 0 : q.expectAny.some((k) => refKeys.includes(k));
  const recallAll = !q.expectAll || q.expectAll.every((k) => refKeys.includes(k));
  const precision = refKeys.length === 0 ? (expected.size === 0 ? 1 : 0) : refKeys.filter((k) => expected.has(k)).length / refKeys.length;
  const failClosed = Boolean(res.finance_fail_closed || res.no_answer) || FAIL_CLOSED_RE.test(res.answer);
  const regexLeak = GARBAGE_TERMS.filter((t) => res.answer.includes(`关键词「${t}」`));
  const answerOk = (q.expectAnswerContains ?? []).every((s) => res.answer.includes(s));
  // 负控题：必须拒答且不给引用；其余题：召回到期望笔记、不回显垃圾关键词
  const pass =
    q.expectAny.length === 0
      ? failClosed && refKeys.length === 0
      : recall && recallAll && regexLeak.length === 0 && answerOk;
  return { id: q.id, question: q.question, origin: q.origin, gate: q.gate !== false, refKeys, recall, recallAll, precision, failClosed, regexLeak, answerOk, pass, ms, answer: res.answer };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  let queries = QUERIES;
  if (ONLY.length > 0) queries = queries.filter((q) => ONLY.includes(q.id));
  console.log(`retrieval-eval：API=${API}，问题 ${queries.length} 个`);
  await ensureAccount();
  const results: QResult[] = [];
  try {
    const idByKey = await seed();
    await waitForEmbeddings();
    await waitForAmounts(idByKey);
    for (const q of queries) {
      const r = await runQuery(q, idByKey);
      results.push(r);
      console.log(
        `  ${r.id} ${r.pass ? "通过✓" : "未过✗"} [${r.ms}ms] 召回 ${r.refKeys.join(",") || "（空）"}${
          r.regexLeak.length ? ` 垃圾关键词回显：${r.regexLeak.join("/")}` : ""
        }`
      );
      if (!r.pass) console.log(`     ${r.question} → ${r.answer.slice(0, 160).replace(/\n/g, " ")}`);
    }
  } finally {
    await destroyAccount();
  }

  const positives = results.filter((r) => r.refKeys.length > 0 || !r.failClosed);
  const recallRate = results.filter((r) => r.recall).length / results.length;
  const precisionAvg = results.reduce((a, r) => a + r.precision, 0) / results.length;
  const zeroRecall = results.filter((r) => r.failClosed && r.refKeys.length === 0).length;
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))] ?? 0;
  const gateFail = results.filter((r) => r.gate && !r.pass);
  console.log(
    `\n汇总：召回率 ${pct(recallRate)}，平均精确率 ${pct(precisionAvg)}，确定性零命中 ${zeroRecall}/${results.length}，` +
      `延迟 p50 ${p(0.5)}ms / p95 ${p(0.95)}ms（有效答题 ${positives.length}）`
  );
  console.log(`回归门：必过题未过 ${gateFail.length}${gateFail.length ? `（${gateFail.map((r) => r.id).join(",")}）` : ""}`);
  if (OUT) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(
      OUT,
      JSON.stringify({ api: API, at: new Date().toISOString(), recallRate, precisionAvg, zeroRecall, p50: p(0.5), p95: p(0.95), results }, null, 2),
      "utf8"
    );
    console.log(`结果写入 ${OUT}`);
  }
  if (gateFail.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
