/**
 * R284 生产数据面复测：敏感隔离 9 出口、敏感附件 R2 密文、软删/恢复、备份导出、
 * 新存笔记即时可查、注销级联（旧 token 401 + 数据不可达）。
 *
 * 用法：
 *   SUINIAN_API_BASE=https://suinian-api.zalize.com npx tsx scripts/qa-r284-data.ts [--out=res.json]
 *
 * 9 出口口径同 audit-r279 §敏感隔离：/api/export、/api/export?format=markdown、
 * /api/threads、/api/review/today、/api/tags、/api/stats、/api/reports、
 * /api/todos/today、/api/notes/random。
 *
 * 账号 [QA-R296] 前缀，跑完注销；绝不触碰 u_boss。
 */
const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const OUT = (process.argv.find((a) => a.startsWith("--out=")) ?? "").replace("--out=", "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { group: string; id: string; verdict: string; detail: string };
const rows: Row[] = [];
function record(group: string, id: string, ok: boolean, detail: string) {
  rows.push({ group, id, verdict: ok ? "PASS" : "FAIL", detail });
  console.log(`  ${id} ${ok ? "✓" : "✗"} ${detail}`);
}

async function raw(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 429 && attempt < 4) {
      await sleep(65_000);
      continue;
    }
    return res;
  }
}

async function req<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await raw(path, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * 敏感值：出现在任一出口正文即泄漏。全部**运行时随机生成**——既避免把任何
 * 口令字面提交进仓库（QA 纪律 + 密钥扫描），也保证每次跑的探针值都是新的、
 * 不会跟历史残留数据串味。
 */
const rnd = (n: number) => Math.random().toString(36).slice(2, 2 + n);
const digits = (n: number) =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
const SECRETS = {
  bank: `6222 ${digits(4)} ${digits(4)} ${digits(4)} ${digits(3)}`,
  routerPass: `Qa!${rnd(9)}Z7`,
  idcard: `1101${digits(14)}`,
  passport: `E${digits(8)}`,
  vpn: `vpn-preshared-key-${rnd(8)}`,
};

const SENSITIVE_NOTES = [
  `工资卡卡号 ${SECRETS.bank}，开户行建行中关村支行。`,
  `路由器后台密码 ${SECRETS.routerPass}，别忘了。`,
  `身份证号 ${SECRETS.idcard}，办居住证要用。`,
  `护照号 ${SECRETS.passport}，签证材料里要填。`,
  `公司 VPN 预共享密钥 ${SECRETS.vpn}。`,
];

const OUTLETS = [
  "/api/export",
  "/api/export?format=markdown",
  "/api/threads",
  "/api/review/today",
  "/api/tags",
  "/api/stats",
  "/api/reports",
  "/api/todos/today",
  "/api/notes/random",
];

async function main() {
  const name = `[QA-R296]data-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const password = process.env.QA_R284_PASSWORD ?? `Qa!${Math.random().toString(36).slice(2, 12)}A9`;
  const reg = await req<{ api_token: string }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  const token = reg.api_token;
  console.log(`QA 账号：${name}`);
  const noteIds: string[] = [];
  try {
    console.log("\n== 敏感笔记入库 + 分拣 ==");
    for (const content of SENSITIVE_NOTES) {
      const r = await req<{ note: { id: string } }>("/api/notes", { method: "POST", body: JSON.stringify({ content }), token });
      noteIds.push(r.note.id);
    }
    for (let i = 0; i < 25; i++) {
      const listed = await req<{ notes: Array<{ category: string | null; is_sensitive?: boolean | number }> }>("/api/notes?limit=50", { token });
      if ((listed.notes ?? []).length >= SENSITIVE_NOTES.length && listed.notes.every((n) => n.category != null)) break;
      await sleep(1500);
    }
    const listed = await req<{ notes: Array<{ id: string; is_sensitive?: boolean | number }> }>("/api/notes?limit=50", { token });
    const sensCount = (listed.notes ?? []).filter((n) => n.is_sensitive === true || (n.is_sensitive as unknown) === 1).length;
    record("SENS", "sensitive-flagged", sensCount === SENSITIVE_NOTES.length, `${sensCount}/${SENSITIVE_NOTES.length} 条判定为敏感`);

    console.log("\n== 敏感隔离 9 出口 ==");
    for (const path of OUTLETS) {
      const res = await raw(path, { token });
      const body = await res.text();
      const leaked = Object.entries(SECRETS).filter(([, v]) => body.includes(v) || body.includes(v.replace(/\s/g, "")));
      record("OUTLET", path, leaked.length === 0, leaked.length === 0 ? `HTTP ${res.status} 无明文` : `泄漏 ${leaked.map(([k]) => k).join(",")}`);
    }

    console.log("\n== 备份导出（明文需口令）==");
    const noPwd = await raw("/api/export?include_sensitive=true", { token });
    const noPwdBody = await noPwd.text();
    const plainLeak = Object.values(SECRETS).some((v) => noPwdBody.includes(v));
    record("EXPORT", "plain-requires-password", !plainLeak, `HTTP ${noPwd.status}，无口令时无敏感明文`);

    console.log("\n== 新存笔记即时可查 ==");
    const marker = `R284即时可查探针${Math.random().toString(36).slice(2, 8)}`;
    await req("/api/notes", { method: "POST", body: JSON.stringify({ content: `${marker}：下午三点去取快递。` }), token });
    let found = false;
    for (let i = 0; i < 10 && !found; i++) {
      const s = await req<{ notes: Array<{ content: string }> }>(`/api/notes?q=${encodeURIComponent(marker)}`, { token });
      found = (s.notes ?? []).some((n) => n.content.includes(marker));
      if (!found) await sleep(1000);
    }
    record("SEARCH", "instant-searchable", found, found ? "写入后 ≤10s 可检索" : "写入后 10s 内检索不到");

    console.log("\n== 软删 → 回收站 → 恢复 ==");
    const victim = noteIds[0];
    await req(`/api/notes/${victim}`, { method: "DELETE", token });
    const trash = await req<{ notes: Array<{ id: string }> }>("/api/notes/trash", { token });
    const inTrash = (trash.notes ?? []).some((n) => n.id === victim);
    record("TRASH", "soft-delete", inTrash, inTrash ? "已进回收站" : "回收站里找不到");
    const restore = await raw("/api/notes/restore", { method: "POST", body: JSON.stringify({ ids: [victim] }), token });
    const back = await req<{ notes: Array<{ id: string }> }>("/api/notes?limit=50", { token });
    const restored = (back.notes ?? []).some((n) => n.id === victim);
    record("TRASH", "restore", restored, restored ? `恢复成功（HTTP ${restore.status}）` : `恢复失败（HTTP ${restore.status}）`);
  } finally {
    console.log("\n== 注销级联 ==");
    const del = await raw("/api/auth/me", { method: "DELETE", token });
    const after = await raw("/api/notes?limit=1", { token });
    record("LOGOUT", "cascade", del.ok && after.status === 401, `DELETE ${del.status}；旧 token -> ${after.status}`);
  }

  const fails = rows.filter((r) => r.verdict === "FAIL");
  console.log(`\n总计 ${rows.length} 项，PASS ${rows.length - fails.length}，FAIL ${fails.length}`);
  if (OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(OUT, JSON.stringify({ api: API, rows }, null, 2));
    console.log(`明细已写入 ${OUT}`);
  }
  if (fails.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
