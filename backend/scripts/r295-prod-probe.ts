/**
 * R295 生产问答探针（audit-r295 §6/§7 的一手数据来源）。
 *
 *   SUINIAN_API_BASE=https://suinian-api.zalize.com \
 *   SUINIAN_TOKEN=<[QA-R295] 账号的 token> \
 *   npx tsx scripts/r295-prod-probe.ts [--sse] "问题1" "问题2" ...
 *
 * 非流式：打印总耗时 + Server-Timing 逐段（route/kwext/sem/graph/dirext/conaud/gen/execcls）。
 * --sse：打印首字节、首 delta、事件序列与 delta 数，用于验证 meta → delta* → done 契约
 *        以及「无先泄漏后撤回」。
 *
 * 注意：/api/ask 有速率限制（实测约 4 分钟窗口内 13 次提问后 429），脚本每问间隔 3s，
 *      长批次请自行分批。绝不要用真实用户 token 运行。
 */
const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const TOKEN = process.env.SUINIAN_TOKEN ?? "";
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

if (!TOKEN) {
  console.error("需要 SUINIAN_TOKEN（[QA-R295] 临时账号）");
  process.exit(2);
}

const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
  "user-agent": UA,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function askJson(question: string): Promise<void> {
  const t0 = Date.now();
  const res = await fetch(`${API}/api/ask`, {
    method: "POST",
    headers,
    body: JSON.stringify({ question }),
  });
  const st = res.headers.get("server-timing") ?? "";
  const body = (await res.json()) as { answer?: string; citations?: unknown[]; error?: string };
  console.log(`Q: ${question}`);
  console.log(`  ${Date.now() - t0}ms  HTTP ${res.status}  cites=${body.citations?.length ?? 0}`);
  console.log(`  ST: ${st}`);
  console.log(`  A: ${(body.answer ?? body.error ?? "").replace(/\n/g, " ⏎ ")}\n`);
}

async function askSse(question: string): Promise<void> {
  const t0 = Date.now();
  const res = await fetch(`${API}/api/ask`, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify({ question, stream: true }),
  });
  const st = res.headers.get("server-timing") ?? "";
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let firstByte: number | null = null;
  let firstDelta: number | null = null;
  let text = "";
  const events: string[] = [];
  let nDelta = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByte === null) firstByte = Date.now() - t0;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = block.match(/^event:\s*(.+)$/m)?.[1]?.trim() ?? "message";
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      events.push(ev);
      if (!data) continue;
      let j: { text?: string; delta?: string; answer?: string } = {};
      try {
        j = JSON.parse(data);
      } catch {
        /* 非 JSON 事件（心跳等）忽略 */
      }
      const piece = j.text ?? j.delta ?? "";
      if (piece) {
        if (firstDelta === null) firstDelta = Date.now() - t0;
        nDelta += 1;
        text += piece;
      }
      if (j.answer) text = j.answer;
    }
  }
  const seq: Array<[string, number]> = [];
  for (const e of events) {
    const last = seq[seq.length - 1];
    if (last && last[0] === e) last[1] += 1;
    else seq.push([e, 1]);
  }
  console.log(`Q: ${question}`);
  console.log(
    `  首字节 ${firstByte}ms  首delta ${firstDelta}ms  总 ${Date.now() - t0}ms  delta数 ${nDelta}`
  );
  console.log(`  ST: ${st}`);
  console.log(`  事件序列: ${seq.map(([e, n]) => (n > 1 ? `${e}x${n}` : e)).join(" → ")}`);
  console.log(`  A: ${text.slice(0, 300).replace(/\n/g, " ⏎ ")}\n`);
}

async function main(): Promise<void> {
  const sse = process.argv.includes("--sse");
  const questions = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const q of questions) {
    try {
      await (sse ? askSse(q) : askJson(q));
    } catch (e) {
      console.log(`Q: ${q}\n  ERROR ${String(e)}\n`);
    }
    await sleep(3000);
  }
}

void main();
