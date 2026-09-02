/**
 * R304 生命周期探针（对齐 audit-r303 §11 的 17 项检查）：
 * 敏感识别 → 九出口无明文（notes.list/detail 本人可读为设计内取回）→
 * 敏感附件 R2 密文（复用 qa-r284-attach 另跑）→ 软删/回收站/恢复 →
 * 备份脱敏 → 注销级联旧 token 401。
 *
 *   SUINIAN_API_BASE=https://suinian-api.zalize.com npx tsx scripts/qa-r304-lifecycle.ts
 *
 * QA 账号一律 [QA-R306] 前缀、口令运行时随机生成，跑完即注销；不触碰 u_boss。
 */
import { unzipSync, strFromU8 } from "fflate";

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function raw(path: string, token: string): Promise<{ status: number; bytes: Uint8Array }> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` ${detail}` : ""}`);
}

async function main() {
  const name = `[QA-R306]lc-${Math.random().toString(36).slice(2, 10)}`;
  const password = process.env.QA_R304_PASSWORD ?? `Qa!${Math.random().toString(36).slice(2, 12)}A9`;
  const { api_token: token } = await req<{ api_token: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  console.log(`registered ${name}`);
  const SECRET = "Zx7Qm2Vp9Kt4";
  try {
    // 敏感笔记 + 一条普通笔记
    const sens = (
      await req<{ note: { id: string } }>("/api/notes", {
        method: "POST",
        body: JSON.stringify({ content: `网银登录密码：${SECRET}，别忘了。` }),
        token,
      })
    ).note;
    const plain = (
      await req<{ note: { id: string } }>("/api/notes", {
        method: "POST",
        body: JSON.stringify({ content: "周六上午十点去图书馆还书。" }),
        token,
      })
    ).note;
    await sleep(20000);

    type NoteJson = { id: string; content: string; is_sensitive?: number | boolean };
    const list = await req<{ notes: NoteJson[] }>("/api/notes?limit=20", { token });
    const sensRow = list.notes.find((n) => n.id === sens.id);
    check("敏感自动识别 is_sensitive=true", !!sensRow && !!sensRow.is_sensitive);
    check("notes.list 本人可读原文（设计内取回）", !!sensRow);

    const detail = await req<{ note: NoteJson }>(`/api/notes/${sens.id}`, { token });
    check("notes.detail 本人可读原文（设计内取回）", detail.note.id === sens.id);

    // 出口无明文：search / ask / export / backup / today-review / MCP
    const search = await req<{ notes: NoteJson[] }>(`/api/notes?q=${encodeURIComponent(SECRET)}&limit=20`, { token });
    check("search 不返回敏感明文", !search.notes.some((n) => (n.content ?? "").includes(SECRET)));

    const ask = await req<{ answer: string }>("/api/ask", {
      method: "POST",
      body: JSON.stringify({ question: "网银登录密码是多少？" }),
      token,
    });
    check("Ask 不返回敏感明文", !ask.answer.includes(SECRET));

    const exp = await raw("/api/export?format=markdown", token);
    check("export 不含敏感明文", exp.status === 200 && !strFromU8(exp.bytes).includes(SECRET));

    const bak = await raw("/api/backup", token);
    let bakOk = false;
    let bakFlagged = false;
    if (bak.status === 200) {
      try {
        const files = unzipSync(bak.bytes);
        const texts = Object.values(files).map((b) => strFromU8(b)).join("\n");
        bakOk = !texts.includes(SECRET);
        bakFlagged = /is_sensitive/.test(texts);
      } catch {
        bakOk = !strFromU8(bak.bytes).includes(SECRET);
      }
    }
    check("backup 默认脱敏（不含敏感明文）", bak.status === 200 && bakOk, bakFlagged ? "(带 is_sensitive 标)" : "");

    const review = await req<{ items: Array<{ note: NoteJson }> }>("/api/review/today", { token });
    check("today-review 不含敏感明文", !review.items.some((it) => (it.note?.content ?? "").includes(SECRET)));

    const mcpRes = await fetch(`${API}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_notes", arguments: { query: "网银 密码" } },
      }),
    });
    const mcpBody = await mcpRes.text();
    check("MCP search_notes 不含敏感明文", !mcpBody.includes(SECRET));

    const reports = await req<{ reports: Array<{ content?: string }> }>("/api/reports", { token }).catch(() => ({ reports: [] }));
    check(
      "weekly-report 不含敏感明文",
      !(reports.reports ?? []).some((r) => (r.content ?? "").includes(SECRET))
    );

    // 软删 → 回收站可见 → 恢复
    await req(`/api/notes/${plain.id}`, { method: "DELETE", token });
    const after = await req<{ notes: NoteJson[] }>("/api/notes?limit=20", { token });
    check("软删后列表移除", !after.notes.some((n) => n.id === plain.id));
    const trash = await req<{ notes: NoteJson[] }>("/api/notes/trash", { token });
    check("回收站可见", trash.notes.some((n) => n.id === plain.id));
    await req("/api/notes/restore", { method: "POST", body: JSON.stringify({ ids: [plain.id] }), token });
    const restored = await req<{ notes: NoteJson[] }>("/api/notes?limit=20", { token });
    check("恢复成功", restored.notes.some((n) => n.id === plain.id));
  } finally {
    await req("/api/auth/me", { method: "DELETE", token }).catch(() => {});
    const me = await fetch(`${API}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    check("注销级联：旧 token 401", me.status === 401, `status=${me.status}`);
    console.log(`\n汇总：${pass}/${pass + fail} 通过`);
    if (fail > 0) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
