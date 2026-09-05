// R319 生产 QA 公共库（R318 副本）：复用 R314/R313 的请求/注册/入库/MCP/ask/SSE 封装，只改账号前缀；
// 注册补 beta 邀请码（环境变量 QA_INVITE_CODE，绝不打印）。

export * from "../../qa-r314/prod/lib.mjs";
import { req, sleep } from "../../qa-r314/prod/lib.mjs";
export const QA_PREFIX = "[QA-R319]";

function genPass() {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return "Qa!" + Array.from(a, (b) => b.toString(36)).join("").slice(0, 14) + "A9";
}

export async function register(name) {
  const password = genPass();
  const invite_code = process.env.QA_INVITE_CODE || undefined;
  for (let i = 0; i < 6; i++) {
    const r = await req("/api/auth/register", { method: "POST", body: { name, password, invite_code } });
    if ((r.status === 200 || r.status === 201) && r.json?.api_token) return { name, password, token: r.json.api_token, user_id: r.json.user?.id ?? r.json.id ?? null, raw: r.json };
    if (r.status === 429) {
      await sleep(65000);
      continue;
    }
    throw new Error(`register failed ${r.status} ${r.text.replace(/[0-9a-f]{40,}/g, "<tok>").slice(0, 200)}`);
  }
  throw new Error("register exhausted retries");
}
