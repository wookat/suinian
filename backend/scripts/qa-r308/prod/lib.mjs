// R308 生产复测脚本：qa-r307/prod、regress 的副本，仅 QA 前缀 [QA-R307]→[QA-R308]、输出目录改 qa-r308/out，逻辑不动。
import { randomBytes } from "node:crypto";
export const API = "https://suinian-api.zalize.com";
export const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const genPass = () => randomBytes(18).toString("base64url");

export async function req(path, { method = "GET", token, body, raw = false } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "user-agent": UA,
      accept: "*/*",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (raw) return { status: res.status, text, headers: res.headers };
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, json, text, headers: res.headers };
}

export async function register(name) {
  const password = genPass();
  for (let i = 0; i < 6; i++) {
    const r = await req("/api/auth/register", { method: "POST", body: { name, password } });
    if ((r.status === 200 || r.status === 201) && r.json?.api_token) return { name, password, token: r.json.api_token, user_id: r.json.user?.id ?? r.json.id ?? null, raw: r.json };
    if (r.status === 429) {
      await sleep(65000);
      continue;
    }
    throw new Error(`register failed ${r.status} ${r.text.replace(/[0-9a-f]{40,}/g,"<tok>").slice(0, 200)}`);
  }
  throw new Error("register exhausted retries");
}

export async function postNote(token, content, extra = {}) {
  for (let i = 0; i < 8; i++) {
    const r = await req("/api/notes", { method: "POST", token, body: { content, ...extra } });
    if (r.status === 200 || r.status === 201) return r.json;
    if (r.status === 429) {
      await sleep(22000);
      continue;
    }
    throw new Error(`postNote failed ${r.status} ${r.text.slice(0, 300)}`);
  }
  throw new Error("postNote exhausted retries");
}

export async function mcpCall(token, name, args) {
  const res = await fetch(API + "/mcp", {
    method: "POST",
    headers: {
      "user-agent": UA,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  return { status: res.status, text };
}
