/**
 * R238 P2 英文×中英混合×中文对照 eval（audit-r237 §3.1 收口锁定）。
 *
 * 用法：
 *   SUINIAN_API_BASE=https://suinian-api.zalize.com npx tsx scripts/ask-lang-eval.ts [--keep]
 *
 * 注册一次性 QA 账号（[QA-R238] 前缀数据），导入小型黄金台账，等待分拣
 * cron 补齐 amount 后，对每个财务意图跑三语问法（en / mixed / zh），断言：
 *   1) 三语都命中确定性管道（响应带 finance_aggregate / extreme_aggregate /
 *      count_aggregate / finance_subset 等确定性标志）；
 *   2) 答案里的确定性数字与中文问法完全一致。
 * 结束后 DELETE /api/auth/me 自清（--keep 保留排查）。
 */

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const KEEP = process.argv.includes("--keep");

let token = process.env.SUINIAN_TOKEN ?? "";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
    });
    if ((res.status === 429 || res.status === 409) && attempt < 4) {
      await sleep(res.status === 429 ? 65_000 * (attempt + 1) : 2_000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }
}

// ---- 黄金台账（全部落在本月内，金额唯一可核） ----
interface SeedNote {
  content: string;
  daysAgo: number;
  category: "expense" | "income";
}
const NOTES: SeedNote[] = [
  { content: "[QA-R238] 买咖啡豆花了 128 元", daysAgo: 3, category: "expense" },
  { content: "[QA-R238] 又买了一包咖啡豆 96 元", daysAgo: 5, category: "expense" },
  { content: "[QA-R238] 买了台咖啡机 899 元", daysAgo: 4, category: "expense" },
  { content: "[QA-R238] 打车去机场 45 元", daysAgo: 6, category: "expense" },
  { content: "[QA-R238] 超市买菜 68.5 元", daysAgo: 2, category: "expense" },
  { content: "[QA-R238] 本月工资到账 15000 元", daysAgo: 7, category: "income" },
];

function backdatedIso(daysAgo: number): string {
  const d = new Date(Date.now() + 8 * 3600_000 - daysAgo * 86400_000);
  return `${d.toISOString().slice(0, 10)} 12:00`;
}

// ---- 三语对照题组：zh 是真值口径，en/mixed 的确定性数字必须与 zh 一致 ----
const DET_FLAGS = [
  "finance_aggregate",
  "finance_subset",
  "finance_compare",
  "finance_extreme",
  "finance_list",
  "extreme_aggregate",
  "count_aggregate",
  "enum_aggregate",
  "topic_summary",
] as const;

interface Triad {
  key: string;
  zh: string;
  en: string;
  mixed: string;
  /** 答案中必须出现的确定性数字（三语一致的核对锚点） */
  nums: string[];
}
const TRIADS: Triad[] = [
  {
    key: "agg-expense",
    zh: "这个月总支出是多少",
    en: "What are my total expenses this month?",
    mixed: "这个月 total expenses 是多少",
    nums: ["1236.5"],
  },
  // R242 P2（audit-r241 §3.1）：「的」字变体×中英聚合问法锁住——
  // 「这个月的总支出」曾因残留「的」落 fail-closed/未找到
  {
    key: "agg-expense-de",
    zh: "这个月的总支出是多少",
    en: "What is the total of my expenses this month?",
    mixed: "这个月的 total expenses 是多少",
    nums: ["1236.5"],
  },
  {
    key: "agg-income",
    zh: "这个月总收入是多少",
    en: "How much is my total income this month?",
    mixed: "这个月 income 总共多少",
    nums: ["15000"],
  },
  {
    key: "extreme-max",
    zh: "最贵的一笔支出是什么",
    en: "What is my most expensive purchase?",
    mixed: "最贵的一笔 purchase 是什么",
    nums: ["899"],
  },
  {
    key: "extreme-min",
    zh: "最便宜的一笔支出是什么",
    en: "What is my cheapest expense?",
    mixed: "cheapest 的一笔支出是哪笔",
    nums: ["45"],
  },
  {
    key: "subset-topic",
    zh: "咖啡豆一共花了多少钱",
    en: "How much did I spend on coffee beans in total?",
    mixed: "coffee beans 一共花了多少钱",
    nums: ["224"],
  },
  {
    key: "count-topic",
    zh: "咖啡豆买了多少次",
    en: "How many times did I buy coffee beans?",
    mixed: "coffee beans 买了多少次",
    nums: ["2"],
  },
];

type AskRes = { answer: string } & Partial<Record<(typeof DET_FLAGS)[number], boolean>>;

async function ask(question: string): Promise<AskRes> {
  return api<AskRes>("/api/ask", { method: "POST", body: JSON.stringify({ question }) });
}

function detFlag(res: AskRes): string | null {
  for (const f of DET_FLAGS) if (res[f]) return f;
  return null;
}

async function main(): Promise<void> {
  if (!token) {
    const name = `qa-r238-lang-${Math.random().toString(36).slice(2, 8)}`;
    const reg = await api<{ api_token: string; user: { id: string } }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, password: `Eval-${crypto.randomUUID()}` }),
    });
    token = reg.api_token;
    console.log(`registered ${reg.user.id} (${name})`);
  }

  const md = NOTES.map((n) => `${backdatedIso(n.daysAgo)}\n${n.content}`).join("\n\n---\n\n");
  await api("/api/import", { method: "POST", body: JSON.stringify({ source: "markdown", content: md }) });
  const { notes } = await api<{ notes: { id: string; content: string }[] }>("/api/notes?limit=100");
  for (const n of NOTES) {
    const row = notes.find((x) => x.content === n.content);
    if (!row) throw new Error(`seed missing: ${n.content}`);
    await api(`/api/notes/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: n.content, category: n.category, tags: ["QA-R238"] }),
    });
    await sleep(150);
  }
  console.log(`seeded ${NOTES.length} ledger notes, waiting for triage amounts (cron, up to ~12min)...`);
  for (let i = 0; i < 150; i++) {
    await sleep(5000);
    const res = await api<{ notes: { content: string; amount?: number | null }[] }>("/api/notes?limit=100");
    const missing = NOTES.filter((n) => res.notes.find((x) => x.content === n.content)?.amount == null);
    if (missing.length === 0) {
      console.log(`amounts ready after ~${(i + 1) * 5}s`);
      break;
    }
    if (i === 149) console.warn(`warning: amounts still missing: ${missing.map((m) => m.content).join(" | ")}`);
    if (i % 12 === 11) console.log(`  still waiting: ${missing.length} notes without amount`);
  }

  let pass = 0;
  let fail = 0;
  for (const t of TRIADS) {
    const langs = [
      ["zh", t.zh],
      ["en", t.en],
      ["mixed", t.mixed],
    ] as const;
    const results: Record<string, AskRes> = {};
    for (const [lang, q] of langs) {
      results[lang] = await ask(q);
      await sleep(1500);
    }
    for (const [lang] of langs) {
      const r = results[lang];
      const flag = detFlag(r);
      const numsOk = t.nums.every((n) => r.answer.includes(n));
      const ok = Boolean(flag) && numsOk;
      ok ? pass++ : fail++;
      console.log(
        `${ok ? "PASS" : "FAIL"} ${t.key}/${lang} det=${flag ?? "none"} nums=${numsOk} :: ${r.answer.slice(0, 90).replace(/\n/g, " ")}`
      );
    }
  }
  console.log(`\ntotal: ${pass} pass, ${fail} fail (of ${TRIADS.length * 3})`);

  if (!KEEP) {
    await api("/api/auth/me", { method: "DELETE" });
    console.log("eval account deleted");
  }
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
