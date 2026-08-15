/**
 * R138 P1 千条压测：千条量级全量线索重整是否全程收敛（cluster + summarize）。
 *
 * 步骤（分步执行，token 存 .qa-r138-token 本地文件，不入库）：
 *   seed    注册 [QA-R138] 临时账号并 /api/import 导入 N 条（默认 1000）合成 idea 笔记。
 *           导入的笔记 category 为 NULL，需要用 D1 直连把该账号笔记置为 idea：
 *           npx wrangler d1 execute suinian --remote --command \
 *             "UPDATE notes SET category='idea' WHERE user_id='<uid>'"
 *   rebuild 触发 POST /api/threads/rebuild 并轮询 job 直到 done/error/超时。
 *   cleanup 注销账号（级联清库）。
 *
 * Usage: npx tsx scripts/qa-r138-stress.ts <seed|rebuild|cleanup> [count]
 */

import { readFileSync, writeFileSync, rmSync } from "node:fs";

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const TOKEN_FILE = ".qa-r138-token";
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
  "手冲咖啡快闪店",
  "邻里快递代收小程序",
  "星空摄影计划",
  "日语五十音学习",
  "阳台种菜实验",
  "二手书交换角",
  "跑步改游泳的健身计划",
  "播客《普通人副业》",
  "猫咪自动喂食器改装",
  "周末骑行路线收集",
];

function syntheticNotes(count: number): string {
  const lines: string[] = [];
  const base = Date.now() + 8 * 3600_000;
  for (let i = 0; i < count; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const d = new Date(base - (count - i) * 3_600_000);
    const ts = `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
    lines.push(`${ts}\n[QA-R138] ${topic}想法 ${i}：第 ${i} 条关于${topic}的碎片记录，包含细节 ${i % 97} 和进展 ${i % 13}。`);
  }
  return lines.join("\n\n---\n\n");
}

async function seed(count: number): Promise<void> {
  const name = `qa-r138-stress-${Math.random().toString(36).slice(2, 8)}`;
  const password = `Qa!${Math.random().toString(36).slice(2, 10)}A1`;
  const reg = await api<{ api_token: string; user: { id: string } }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  token = reg.api_token;
  writeFileSync(TOKEN_FILE, token);
  console.log(`registered [QA-R138] account ${name} user_id=${reg.user.id}`);
  const stats = await api<{ imported: number; skipped: number }>("/api/import", {
    method: "POST",
    body: JSON.stringify({ source: "markdown", content: syntheticNotes(count) }),
  });
  console.log(`import: imported=${stats.imported} skipped=${stats.skipped} (of ${count})`);
  console.log(`NEXT: set category via D1, then run rebuild:`);
  console.log(`  UPDATE notes SET category='idea' WHERE user_id='${reg.user.id}';`);
}

interface JobJson {
  job_id: string;
  status: string;
  phase: string;
  total: number;
  processed: number;
  summarized: number;
  summarize_total: number;
  threads: number | null;
  error?: string | null;
}

async function rebuild(): Promise<void> {
  token = readFileSync(TOKEN_FILE, "utf8").trim();
  const job = await api<JobJson>("/api/threads/rebuild", { method: "POST", body: JSON.stringify({}) });
  console.log(`job ${job.job_id} status=${job.status} phase=${job.phase}`);
  const start = Date.now();
  for (;;) {
    await sleep(15_000);
    const j = await api<JobJson>(`/api/threads/rebuild/${job.job_id}`);
    const mins = ((Date.now() - start) / 60_000).toFixed(1);
    console.log(
      `  t+${mins}m status=${j.status} phase=${j.phase} processed=${j.processed}/${j.total} threads=${j.threads ?? "-"} summarized=${j.summarized}/${j.summarize_total}${j.error ? ` error=${j.error}` : ""}`
    );
    if (j.status === "done") {
      console.log(`CONVERGED in ${mins} minutes ✅`);
      return;
    }
    if (j.status === "error") {
      console.log(`job ended in visible error state (not stuck running): ${j.error}`);
      return;
    }
    if (Date.now() - start > 90 * 60_000) {
      console.log("TIMEOUT: job still running after 90 minutes ❌ (reproduces the stall)");
      process.exit(1);
    }
  }
}

async function cleanup(): Promise<void> {
  token = readFileSync(TOKEN_FILE, "utf8").trim();
  await api("/api/auth/me", { method: "DELETE" });
  rmSync(TOKEN_FILE, { force: true });
  console.log("deleted QA account (cascade removed all data)");
}

const cmd = process.argv[2];
const count = Number(process.argv[3] ?? "1000");
const run = cmd === "seed" ? () => seed(count) : cmd === "rebuild" ? rebuild : cmd === "cleanup" ? cleanup : null;
if (!run) {
  console.error("usage: npx tsx scripts/qa-r138-stress.ts <seed|rebuild|cleanup> [count]");
  process.exit(2);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
