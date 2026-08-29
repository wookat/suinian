/**
 * R278 SSE 冷路径（无 REST 预热、无答案缓存）真流式验证：
 * 注册 QA 账号 → 导入笔记 → 直接 SSE 提问（每问仅一次，问法带随机后缀避开缓存）→
 * 记录每个 delta 的到达时刻，验证生成路径首 delta 前 fail-closed（无部分残片先行）、
 * delta ≥2 且到达时间分散（生成侧真增量）。契约：delta 不携带引证角标（角标在
 * done 收口时全局重排定稿），每个 delta 的文字必须原样保留在 done.answer 中
 * （fail-closed：不存在先泄后收——done 不得撤回任何已外发内容）。
 * 用法：SUINIAN_API_BASE=https://suinian-api.zalize.com npx tsx scripts/qa-r278-sse-cold.ts [--out=res.json]
 */

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const OUT = (process.argv.find((a) => a.startsWith("--out=")) ?? "").replace("--out=", "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (res.status === 429 && attempt < 6) {
      await sleep(65_000);
      continue;
    }
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

const NOTES = [
  "周末计划：去美术馆看新展，下午和老同学喝咖啡，晚上整理旅行照片。",
  "读书笔记《原则》：极度求真、极度透明；把问题当机器来调试；可信度加权决策。",
  "运维备忘：网关服务每周二发布，发布前跑冒烟用例，回滚窗口 15 分钟。",
  "健身记录：本周跑步三次共 21 公里，配速 5'40''，下周目标 24 公里。",
];
const QUESTIONS = [
  "帮我总结一下最近记的这些笔记",
  "结合我的笔记说说下周该注意什么",
  "我最近的生活和工作状态怎么样？",
  "根据笔记给我三条本周建议",
  "把我的笔记按主题归纳一下",
  "我最近记了哪些方面的内容？总结一下",
];

async function main() {
  const name = `[QA-R284]ssecold-${Date.now().toString(36)}`;
  const password = `Qa-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
  const reg = await req<{ api_token: string; user?: { id: string } }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  const token = reg.api_token;
  console.log(`registered ${name}`);
  for (const n of NOTES) {
    await req("/api/notes", { method: "POST", token, body: JSON.stringify({ content: n }) });
    await sleep(400);
  }
  await sleep(60_000);

  const runs: {
    question: string;
    deltas: { at_ms: number; text: string }[];
    done_answer: string;
    consistent: boolean;
    server_timing: string;
    content_type: string;
    spread_ms: number;
  }[] = [];

  for (const base of QUESTIONS) {
    const q = `${base}（${Math.random().toString(36).slice(2, 6)}）`;
    const started = Date.now();
    const res = await fetch(`${API}/api/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ question: q }),
    });
    const ct = res.headers.get("content-type") ?? "";
    const st = res.headers.get("server-timing") ?? "";
    const deltas: { at_ms: number; text: string }[] = [];
    let done = "";
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (\S+)/m.exec(frame)?.[1];
        const dataLine = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine);
          if (ev === "delta" && typeof data.text === "string") deltas.push({ at_ms: Date.now() - started, text: data.text });
          if (ev === "done" && typeof data.answer === "string") done = data.answer;
        } catch {}
      }
    }
    const spread = deltas.length >= 2 ? deltas[deltas.length - 1].at_ms - deltas[0].at_ms : 0;
    const stripMarks = (t: string) => t.replace(/\s*[[［]\d{1,2}[\]］]/g, "");
    const fold = (t: string) => stripMarks(t).replace(/\s+/g, "");
    const doneFolded = fold(done);
    const leaked = deltas.filter((d) => !doneFolded.includes(fold(d.text)));
    const markersInDelta = deltas.some((d) => /[[［]\d{1,2}[\]］]/.test(d.text));
    const consistent = leaked.length === 0 && !markersInDelta;
    runs.push({ question: q, deltas, done_answer: done, consistent, server_timing: st, content_type: ct, spread_ms: spread });
    console.log(
      `${q} → deltas=${deltas.length} spread=${spread}ms failclosed=${consistent}${leaked.length ? ` leaked=${leaked.length}` : ""}${markersInDelta ? " markers-in-delta" : ""} ct=${ct.split(";")[0]} conaud=${st.includes("conaud")}`
    );
    await sleep(35_000);
  }

  await req("/api/auth/me", { method: "DELETE", token });
  const check = await fetch(`${API}/api/auth/me?probe=${Date.now()}`, { headers: { authorization: `Bearer ${token}` } });
  console.log(`account deleted; old token status=${check.status}`);

  if (OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(OUT, JSON.stringify({ api: API, at: new Date().toISOString(), runs }, null, 2));
    console.log(`结果写入 ${OUT}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
