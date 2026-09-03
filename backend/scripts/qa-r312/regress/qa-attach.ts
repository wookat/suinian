/**
 * R309 审查方副本（源 qa-r284-attach.ts；改前缀/输出路径，加注销后 401 与 R2 对象消失核验）：敏感附件 R2 密文验证：上传含敏感内容的文本文件附件 → 等分拣判敏感 →
 * 用 wrangler 直读 R2 对象头 4 字节，断言 SNE1 加密信封；随后注销账号。
 * 打印出 R2 key，供后续权威列举核查。
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function main() {
  const name = `[QA-R312]att-${Date.now().toString(36)}`;
  const password = process.env.QA_R284_PASSWORD ?? `Qa!${Math.random().toString(36).slice(2, 12)}A9`;
  const reg = await req<{ api_token: string }>("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  const token = reg.api_token;
  console.log(`QA 账号：${name}`);
  let r2KeyForCleanup: string | undefined;
  try {
    // 探针里的卡号/口令运行时随机生成：不把任何口令字面提交进仓库
    const digits = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");
    const cardNo = `6222 ${digits(4)} ${digits(4)} ${digits(4)} ${digits(3)}`;
    const payPin = digits(6);
    const secret = `银行卡号 ${cardNo}，取款密码 ${payPin}，妥善保管。`;
    const fd = new FormData();
    fd.set("type", "file");
    fd.set("file", new Blob([secret], { type: "text/plain" }), "bank-info.txt");
    const up = await req<{ note: { id: string; is_sensitive?: boolean; meta?: { r2_key?: string } } }>(
      "/api/ingest/media",
      { method: "POST", body: fd, token }
    );
    const noteId = up.note.id;
    console.log(`附件笔记 ${noteId}`);
    let n: { is_sensitive?: boolean; meta?: { r2_key?: string } } | null = null;
    for (let i = 0; i < 30; i++) {
      n = await req<{ note: typeof n }>(`/api/notes/${noteId}`, { token }).then((r) => r.note);
      if (n?.is_sensitive) break;
      await sleep(2000);
    }
    console.log(`is_sensitive=${n?.is_sensitive}`);
    const d1raw = execFileSync(
      "npx",
      ["wrangler", "d1", "execute", "suinian", "--remote", "--json", "--command", `SELECT r2_key FROM attachments WHERE note_id = '${noteId}'`],
      { env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_GLOBAL_API_TOKEN } }
    ).toString();
    const key: string | undefined = JSON.parse(d1raw)?.[0]?.results?.[0]?.r2_key;
    console.log(`r2_key=${key}`);
    if (!key) throw new Error("拿不到 r2_key，无法直读 R2");
    execFileSync("npx", ["wrangler", "r2", "object", "get", `suinian-media/${key}`, "--file", "scripts/qa-r312/out/att.bin", "--remote"], {
      stdio: "inherit",
      env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_GLOBAL_API_TOKEN },
    });
    const { readFileSync } = await import("node:fs");
    const head = readFileSync("scripts/qa-r312/out/att.bin").subarray(0, 4).toString("latin1");
    const body = readFileSync("scripts/qa-r312/out/att.bin").toString("latin1");
    const plaintextLeak = body.includes(cardNo.replace(/\s/g, "")) || body.includes(cardNo) || body.includes(payPin);
    console.log(`R2 对象头: "${head}"（期望 SNE1）；明文泄漏: ${plaintextLeak}`);
    if (head !== "SNE1" || plaintextLeak) process.exitCode = 1;
    console.log(`R2_KEY_FOR_CLEANUP=${key}`);
    r2KeyForCleanup = key;
  } finally {
    const del = await fetch(`${API}/api/auth/me`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    const me = await fetch(`${API}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    console.log(`注销 -> ${del.status}；旧 token -> ${me.status}`);
    if (r2KeyForCleanup) {
      await sleep(3000);
      const r = require("node:child_process").spawnSync("npx", ["wrangler", "r2", "object", "get", `suinian-media/${r2KeyForCleanup}`, "--file", "scripts/qa-r312/out/att-after.bin", "--remote"], {
        env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_GLOBAL_API_TOKEN }, encoding: "utf8",
      });
      console.log(`注销后 R2 对象读取 exit=${r.status}（期望非 0 = 已级联删除）: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-2).join(" | ")}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
