// R312 生产 QA 公共库：复用 R311 的请求/注册/入库/MCP 封装，只改账号前缀与出口头。
export * from "../../qa-r311/prod/lib.mjs";
import { req, sleep } from "../../qa-r311/prod/lib.mjs";

export const QA_PREFIX = "[QA-R312]";
export const OUTLET_HEADER = "x-suinian-outlet";

/** /api/ask，tier="agg" 时带 MCP 出口头（服务端确定性走聚合层），"direct" 走 app 出口。 */
export async function ask(token, question, { history, tier = "direct" } = {}) {
  for (let i = 0; i < 6; i++) {
    const t0 = Date.now();
    const res = await fetch("https://suinian-api.zalize.com/api/ask", {
      method: "POST",
      headers: {
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(tier === "agg" ? { [OUTLET_HEADER]: "mcp" } : {}),
      },
      body: JSON.stringify({ question, ...(history ? { history } : {}) }),
    });
    const text = await res.text();
    if (res.status === 429) {
      await sleep(20000);
      continue;
    }
    if (res.status >= 500 && res.status <= 504) {
      await sleep(5000 * (i + 1));
      continue;
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep text */
    }
    return { status: res.status, ms: Date.now() - t0, json, text };
  }
  return { status: 429, ms: 0, json: null, text: "" };
}

export { req, sleep };
