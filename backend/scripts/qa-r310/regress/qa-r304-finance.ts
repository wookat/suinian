/**
 * R304 财务 ≥34 问法逐笔对底账（audit-r303 遗留：财务问答与周报口径一致性）。
 *
 * 先落一份确定性底账（2026-07/08 共 16 笔，金额互不歧义），本地算出
 * 各口径真值，再用 ≥34 种问法问 Ask，逐题断言真值数字出现在答案里，
 * 且不得答「没有找到相关记录」。
 *
 *   SUINIAN_API_BASE=https://suinian-api.zalize.com npx tsx scripts/qa-r304-finance.ts
 *
 * QA 账号一律 [QA-R310] 前缀、口令运行时随机生成，跑完即注销。
 */
const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(20000);
      continue;
    }
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

// 底账（事件时间写进正文；金额全部唯一，避免歧义匹配）
const LEDGER = [
  "2026年8月3日 午饭花了 32 元",
  "2026年8月3日 打车花了 18 元",
  "2026年8月5日 买书花了 89 元",
  "2026年8月10日 电影票花了 45 元",
  "2026年8月12日 交房租支出 2400 元",
  "2026年8月15日 咖啡花了 24 元",
  "2026年8月18日 超市购物花了 156 元",
  "2026年8月20日 话费充值花了 100 元",
  "2026年8月25日 请朋友吃饭花了 210 元",
  "2026年7月6日 买机械键盘花了 349 元",
  "2026年7月15日 交水电费支出 180 元",
  "2026年7月28日 理发花了 40 元",
  "2026年8月8日 发工资收入 8000 元",
  "2026年8月16日 卖二手显示器收入 600 元",
  "2026年7月10日 兼职收入 1200 元",
  "2026年8月28日 退款收入 77 元",
];
// 真值（本地逐笔算）：
// 8月支出 32+18+89+45+2400+24+156+100+210 = 3074；8月收入 8000+600+77 = 8677
// 7月支出 349+180+40 = 569；7月收入 1200
// 总支出 3643；总收入 9877；结余 6234；8月结余 5603
// 8月3日支出 50；超过150元的支出：2400/349/210/180/156；前三大支出 2400/349/210
// 上旬(1-10) 184；中旬(11-20) 2400+24+156+100=2680；下旬(21-31) 210
// 产品口径（答案会主动披露）：「之前」不含当日且不限月份下界、「以后」含当日：
// 8月15日之前（含7月） 2584+569=3153；8月15日以后 24+156+100+210=490

type Q = { q: string; expect: string[]; forbid?: string[] };
const QUESTIONS: Q[] = [
  { q: "我一共花了多少钱？", expect: ["3643"] },
  { q: "我总共支出多少？", expect: ["3643"] },
  { q: "我一共收入多少钱？", expect: ["9877"] },
  { q: "我的总收入是多少？", expect: ["9877"] },
  { q: "我的结余是多少？", expect: ["6234"] },
  { q: "8月结余是多少？", expect: ["5603"] },
  { q: "8月一共花了多少钱？", expect: ["3074"] },
  { q: "八月总支出是多少？", expect: ["3074"] },
  { q: "8月收入多少？", expect: ["8677"] },
  { q: "7月花了多少钱？", expect: ["569"] },
  { q: "7月收入多少？", expect: ["1200"] },
  { q: "8月3日花了多少钱？", expect: ["50"] },
  { q: "8月3日都有哪些消费？", expect: ["32", "18"] },
  { q: "最大一笔支出是什么？", expect: ["2400"] },
  { q: "花得最多的一笔是哪笔？", expect: ["2400"] },
  { q: "最小一笔支出是多少？", expect: ["18"] },
  { q: "支出最多的前三笔是哪些？", expect: ["2400", "349", "210"] },
  { q: "超过150元的支出有哪些？", expect: ["2400", "349", "210", "180", "156"] },
  { q: "低于30元的支出有哪些？", expect: ["18", "24"] },
  { q: "7月支出多少，8月支出多少？", expect: ["569", "3074"] },
  { q: "7月和8月支出各是多少？", expect: ["569", "3074"] },
  { q: "我记了多少笔支出？", expect: ["12"] },
  { q: "我记了几笔收入？", expect: ["4"] },
  { q: "8月上旬花了多少钱？", expect: ["184"] },
  { q: "8月中旬花了多少钱？", expect: ["2680"] },
  { q: "8月下旬花了多少钱？", expect: ["210"] },
  { q: "8月15日之前花了多少钱？", expect: ["3153"] },
  { q: "8月15日以后花了多少钱？", expect: ["490"] },
  { q: "房租花了多少钱？", expect: ["2400"] },
  { q: "水电费花了多少？", expect: ["180"] },
  { q: "买书花了多少钱？", expect: ["89"] },
  { q: "话费充值花了多少？", expect: ["100"] },
  { q: "工资收入是多少？", expect: ["8000"] },
  { q: "卖二手显示器收入多少？", expect: ["600"] },
  { q: "兼职收入是多少？", expect: ["1200"] },
  { q: "8月都有哪些支出？", expect: ["32", "18", "89", "45", "2400", "24", "156", "100", "210"] },
];

const NEG = /没有找到相关记录|没有记账记录/;

async function main() {
  const name = `[QA-R310]fin-${Math.random().toString(36).slice(2, 10)}`;
  const password = process.env.QA_R304_PASSWORD ?? `Qa!${Math.random().toString(36).slice(2, 12)}A9`;
  const { api_token: token } = await req<{ api_token: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  console.log(`registered ${name}; seeding ${LEDGER.length} ledger notes`);
  try {
    for (const content of LEDGER) {
      await req("/api/notes", { method: "POST", body: JSON.stringify({ content }), token });
      await sleep(400);
    }
    console.log("waiting 90s for triage/embeddings");
    await sleep(90000);
    let pass = 0;
    const fails: string[] = [];
    for (const { q, expect } of QUESTIONS) {
      const res = await req<{ answer: string }>("/api/ask", {
        method: "POST",
        body: JSON.stringify({ question: q }),
        token,
      });
      const a = res.answer ?? "";
      const missing = expect.filter((e) => !a.includes(e) && !a.includes(Number(e).toLocaleString("en-US")));
      const neg = NEG.test(a);
      const ok = missing.length === 0 && !neg;
      if (ok) pass++;
      else fails.push(`${q} 缺失[${missing.join(",")}]${neg ? " 且答『没有记录』" : ""}\n  → ${a.slice(0, 200)}`);
      console.log(`${ok ? "✓" : "✗"} ${q}`);
      await sleep(1500);
    }
    console.log(`\n汇总：财务 ${pass}/${QUESTIONS.length}`);
    if (fails.length) {
      console.log("\n失败明细：");
      for (const f of fails) console.log(f);
      process.exitCode = 1;
    }
  } finally {
    await req("/api/auth/me", { method: "DELETE", token }).catch(() => {});
    console.log("account deleted");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
