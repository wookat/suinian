/**
 * R172 千条性能归因/前后对比（不入库，仅本轮 QA 使用）。
 *
 * Usage:
 *   npx tsx scripts/qa-r172-perf.ts seed [count]      注册 [QA-R172] 账号并导入 N 条（默认 1000）
 *   npx tsx scripts/qa-r172-perf.ts measure <label>   测 timeline/search/stats/ask 延迟分位并打印 Server-Timing
 *   npx tsx scripts/qa-r172-perf.ts cleanup           注销账号
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const TOKEN_FILE = ".qa-r172-token";
let token = "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOPICS = [
  "手冲咖啡快闪店", "邻里快递代收小程序", "星空摄影计划", "日语五十音学习", "阳台种菜实验",
  "二手书交换角", "跑步改游泳的健身计划", "播客《普通人副业》", "猫咪自动喂食器改装", "周末骑行路线收集",
];

function syntheticNotes(count: number): string {
  const lines: string[] = [];
  const base = Date.now() + 8 * 3600_000;
  for (let i = 0; i < count; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const d = new Date(base - (count - i) * 3_600_000);
    const ts = `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
    lines.push(`${ts}\n关于${topic}的第 ${i + 1} 条想法：今天又琢磨了一下${topic}，记录一些细节与进展，编号 ${1000 + i}。`);
  }
  return lines.join("\n\n---\n\n");
}

async function seed(count: number) {
  try {
    token = JSON.parse(readFileSync(TOKEN_FILE, "utf8")).token;
    console.log("reusing existing token");
  } catch {
    const name = `[QA-R172]perf-${Date.now().toString(36)}`;
    const password = `QaR172perf${Date.now() % 100000}`;
    const reg = await api<{ api_token: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, password }),
    });
    token = reg.api_token;
    writeFileSync(TOKEN_FILE, JSON.stringify({ token, name, password }));
    console.log(`registered ${name}`);
  }
  const stats = await api<{ imported: number; skipped: number }>("/api/import", {
    method: "POST",
    body: JSON.stringify({ source: "markdown", content: syntheticNotes(count) }),
  });
  console.log(`import: imported=${stats.imported} skipped=${stats.skipped} (of ${count})`);
}

function pct(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
}

async function timedGet(path: string): Promise<{ ms: number; st: string | null }> {
  const t = Date.now();
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  await res.text();
  return { ms: Date.now() - t, st: res.headers.get("server-timing") };
}

async function measure(label: string) {
  token = JSON.parse(readFileSync(TOKEN_FILE, "utf8")).token;
  const SEARCHES = ["咖啡", "副业", "骑行路线", "编号 1500", "阳台种菜", "五十音", "喂食器", "星空", "快闪店", "交换角"];
  const out: Record<string, { p50: number; p95: number; p99?: number; n: number }> = {};
  const stSamples: Record<string, string[]> = { search: [], ask: [] };

  for (const [key, mk] of [
    ["timeline", () => "/api/notes?limit=30"],
    ["stats", () => "/api/stats"],
  ] as const) {
    const times: number[] = [];
    for (let i = 0; i < 30; i++) times.push((await timedGet(mk())).ms);
    out[key] = { p50: pct(times, 50), p95: pct(times, 95), n: times.length };
  }

  {
    const times: number[] = [];
    for (let i = 0; i < 60; i++) {
      const q = SEARCHES[i % SEARCHES.length];
      const r = await timedGet(`/api/notes?q=${encodeURIComponent(q)}&limit=30`);
      times.push(r.ms);
      if (r.st && stSamples.search.length < 8) stSamples.search.push(`${q}: ${r.st} (wall ${r.ms}ms)`);
    }
    out.search = { p50: pct(times, 50), p95: pct(times, 95), p99: pct(times, 99), n: times.length };
  }

  {
    const ASKS = [
      "我最近对手冲咖啡快闪店有什么想法",
      "阳台种菜实验进展怎么样",
      "副业播客我记录过什么",
      "关于星空摄影我说过什么",
      "骑行路线我收集了哪些",
      "日语学习我记了什么",
      "猫咪喂食器改装有什么细节",
      "二手书交换角是什么",
    ];
    const times: number[] = [];
    for (let i = 0; i < 16; i++) {
      const q = ASKS[i % ASKS.length];
      const t = Date.now();
      const res = await fetch(`${API}/api/ask`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ question: q }),
      });
      await res.text();
      const ms = Date.now() - t;
      times.push(ms);
      const st = res.headers.get("server-timing");
      if (st && stSamples.ask.length < 8) stSamples.ask.push(`${q}: ${st} (wall ${ms}ms)`);
      await sleep(2000);
    }
    out.ask = { p50: pct(times, 50), p95: pct(times, 95), n: times.length };
  }

  console.log(`\n==== ${label} @ ${API} ====`);
  for (const [k, v] of Object.entries(out)) console.log(`${k}: p50=${v.p50}ms p95=${v.p95}ms${v.p99 ? ` p99=${v.p99}ms` : ""} (n=${v.n})`);
  for (const [k, arr] of Object.entries(stSamples)) {
    if (arr.length) console.log(`\n-- Server-Timing samples (${k}) --\n${arr.join("\n")}`);
  }
}

async function cleanup() {
  token = JSON.parse(readFileSync(TOKEN_FILE, "utf8")).token;
  await api("/api/auth/me", { method: "DELETE" });
  rmSync(TOKEN_FILE);
  console.log("account deleted");
}

const cmd = process.argv[2];
if (cmd === "seed") seed(Number(process.argv[3] ?? 1000));
else if (cmd === "measure") measure(process.argv[3] ?? "run");
else if (cmd === "cleanup") cleanup();
else console.log("usage: seed|measure|cleanup");
