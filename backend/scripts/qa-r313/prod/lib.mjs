// R313 生产 QA 公共库：复用 R311/R312 的请求/注册/入库/MCP/ask 封装，只改账号前缀。
export * from "../../qa-r312/prod/lib.mjs";
import { req } from "../../qa-r312/prod/lib.mjs";

export const QA_PREFIX = "[QA-R313]";

/** SSE：POST /api/ask 带 Accept: text/event-stream（web 客户端同款协商），收集 meta/delta/done 事件。 */
export async function askStream(token, question, { history } = {}) {
  const t0 = Date.now();
  const res = await fetch("https://suinian-api.zalize.com/api/ask", {
    method: "POST",
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question, ...(history ? { history } : {}) }),
  });
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) {
    let json = null;
    try { json = JSON.parse(text); } catch { /* raw */ }
    return { status: res.status, ms: Date.now() - t0, sse: false, events: [], deltas: 0, emitted: json?.answer ?? "", done: json, raw: text };
  }
  const events = [];
  let ev = "message";
  for (const line of text.split("\n")) {
    if (line.startsWith("event:")) ev = line.slice(6).trim();
    else if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      let json = null;
      try { json = JSON.parse(data); } catch { /* raw */ }
      events.push({ ev, json, data });
    }
  }
  const deltas = events.filter((e) => e.ev === "delta");
  const done = events.find((e) => e.ev === "done") ?? null;
  const emitted = deltas.map((d) => d.json?.text ?? "").join("");
  return { status: res.status, ms: Date.now() - t0, sse: true, events, deltas: deltas.length, emitted, done: done?.json ?? null, raw: text };
}
export { req };
