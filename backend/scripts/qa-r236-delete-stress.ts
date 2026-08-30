/**
 * R236 P2-2 注销压测：UI 注销请求偶发 ~60s 超时（audit-r235 §5）。
 * 归因验证：级联删除中 threads 表缺 user_id 索引 → DELETE FROM threads
 * WHERE user_id=? 全表扫描；补 idx_threads_user 后测 DELETE /api/auth/me
 * 端到端耗时是否稳定收敛。
 *
 * 每轮：注册 [QA-R296] 临时账号 → /api/import 导入 N 条笔记 →
 * DELETE /api/auth/me 计时 → 校验旧 token 401。
 *
 * Usage: npx tsx scripts/qa-r236-delete-stress.ts [rounds] [notesPerRound]
 *   默认 rounds=5, notesPerRound=200
 */

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";

async function raw(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
  });
}

async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await raw(path, token, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

function syntheticNotes(count: number): string {
  const lines: string[] = [];
  const base = Date.now() + 8 * 3600_000;
  for (let i = 0; i < count; i++) {
    const d = new Date(base - (count - i) * 3_600_000);
    const ts = `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
    lines.push(`${ts}\n[QA-R296] 注销压测笔记 ${i}：合成内容 ${i % 97}，用于级联删除耗时测量。`);
  }
  return lines.join("\n\n---\n\n");
}

async function round(i: number, notes: number): Promise<number> {
  const name = `qa-r236-del-${Math.random().toString(36).slice(2, 8)}`;
  const password = `Qa!${Math.random().toString(36).slice(2, 10)}A1`;
  const reg = await api<{ api_token: string }>("/api/auth/register", "", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  const token = reg.api_token;
  await api("/api/import", token, { method: "POST", body: JSON.stringify({ source: "markdown", content: syntheticNotes(notes) }) });
  const t0 = Date.now();
  const del = await raw("/api/auth/me", token, { method: "DELETE" });
  const elapsed = Date.now() - t0;
  if (!del.ok) throw new Error(`round ${i}: DELETE /api/auth/me -> ${del.status} ${await del.text()}`);
  const check = await raw("/api/notes", token);
  console.log(`round ${i}: ${notes} notes, delete ${elapsed}ms, stale-token -> ${check.status}`);
  if (check.status !== 401) throw new Error(`round ${i}: stale token expected 401, got ${check.status}`);
  return elapsed;
}

async function main(): Promise<void> {
  const rounds = parseInt(process.argv[2] ?? "5", 10);
  const notes = parseInt(process.argv[3] ?? "200", 10);
  const times: number[] = [];
  for (let i = 1; i <= rounds; i++) times.push(await round(i, notes));
  times.sort((a, b) => a - b);
  console.log(`p50=${times[Math.floor(times.length / 2)]}ms max=${times[times.length - 1]}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
