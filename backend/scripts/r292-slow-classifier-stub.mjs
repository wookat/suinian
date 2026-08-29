// R292 近生产复现桩（与 audit-r291 同手法）：
//  - 「代码安全判别器」调用 → sleep 12s（> EXEC_CLASSIFY_BUDGET_MS=8s）制造判别器超时窗口；
//  - 其余生成类调用 → 立刻把用户消息里的资料原文回显，模拟「模型逐字复述危险笔记」的最坏情形。
import { createServer } from "node:http";

const SLEEP_MS = Number(process.env.STUB_SLEEP_MS ?? 12_000);

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* ignore */
  }
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = msgs.find((m) => m.role === "system")?.content ?? "";
  const user = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
  const isClassifier = String(sys).includes("代码安全判别器");
  if (isClassifier) {
    await new Promise((r) => setTimeout(r, SLEEP_MS));
  }
  // 生成类：回显资料区最长的一段原文（模型逐字复述笔记）
  const longest = msgs
    .map((m) => String(m.content ?? ""))
    .sort((a, b) => b.length - a.length)[0] ?? String(user);
  const echo = longest
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-40)
    .join("\n");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: isClassifier ? "（判别器慢桩超时）" : echo } }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    })
  );
  console.log(`stub ${isClassifier ? "CLASSIFIER(slow)" : "gen"} bytes=${raw.length}`);
}).listen(8899, "127.0.0.1", () => console.log("stub on 127.0.0.1:8899"));
