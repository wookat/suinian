// P0-1 生产出口补测：备份 ZIP 逐条字段 / 周报生成 / 线索重建摘要 / MCP 逐条 dangerous。
// 用法：node prod/outlets2.mjs   （依赖 outlets.mjs 已写入的 prod-danger-account.json）
import { writeFileSync, readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { req, mcpCall, sleep, API, UA } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const acct = JSON.parse(readFileSync(`${OUT}/prod-danger-account.json`, "utf8"));
const carriers = JSON.parse(readFileSync(`${OUT}/carriers.json`, "utf8"));
const T = acct.token;
const byNoteId = new Map(Object.entries(acct.notes).map(([id, v]) => [v.note_id, id]));
const summary = {};

// 1. 备份 ZIP：notes.json 每条 contains_executable_command，危险条 exec_warning
{
  const res = await fetch(`${API}/api/backup`, { headers: { authorization: `Bearer ${T}`, "user-agent": UA } });
  const buf = new Uint8Array(await res.arrayBuffer());
  const entries = unzipSync(buf);
  const notes = JSON.parse(strFromU8(entries["notes.json"]));
  const rows = notes.map((n) => ({ id: byNoteId.get(n.id) ?? n.id, sensitive: !!n.is_sensitive, flag: n.contains_executable_command, warn: typeof n.exec_warning === "string" }));
  const missingField = rows.filter((r) => typeof r.flag !== "boolean").map((r) => r.id);
  const unflagged = rows.filter((r) => !r.sensitive && r.flag !== true).map((r) => r.id);
  const flaggedNoWarn = rows.filter((r) => r.flag === true && !r.warn).map((r) => r.id);
  summary.backup = { status: res.status, notes: rows.length, missingField, unflagged, flaggedNoWarn, sensitive: rows.filter((r) => r.sensitive).map((r) => r.id) };
  writeFileSync(`${OUT}/prod-backup-notes.json`, JSON.stringify(rows, null, 1));
  console.log("backup", JSON.stringify(summary.backup));
}

// 2. 周报：生成本周报告，正文危险行须带警示标签，且有总警示
{
  const g = await req(`/api/reports/generate`, { method: "POST", token: T, body: { period: "week", which: "this" } });
  const md = g.json?.report?.content ?? g.json?.report?.body ?? g.json?.report?.markdown ?? JSON.stringify(g.json);
  writeFileSync(`${OUT}/prod-report.md`, md);
  const lines = md.split("\n");
  const danger = lines.filter((l) => /curl|wget|bash|payload|relay3|powershell|nslookup|dig\b/i.test(l));
  const dangerNoWarn = danger.filter((l) => !/〔警示：含可执行命令，勿执行〕/.test(l));
  summary.report = {
    status: g.status,
    keys: Object.keys(g.json?.report ?? {}),
    len: md.length,
    hasNotice: /本期有 \d+ 条笔记含可执行命令/.test(md),
    dangerLines: danger.length,
    dangerNoWarn: dangerNoWarn.slice(0, 10),
  };
  console.log("report", JSON.stringify(summary.report));
}

// 3. 线索：全量重建后摘要须带警示
{
  const rb = await req(`/api/threads/rebuild`, { method: "POST", token: T, body: {} });
  let job = rb.json;
  for (let i = 0; i < 60 && job && job.status !== "done" && job.status !== "failed"; i++) {
    await sleep(5000);
    const p = await req(`/api/threads/rebuild/latest`, { token: T });
    job = p.json;
  }
  const th = await req(`/api/threads`, { token: T });
  writeFileSync(`${OUT}/prod-threads-rebuilt.json`, th.text);
  const threads = th.json?.threads ?? [];
  summary.threads = {
    rebuild: rb.status,
    job: job?.status ?? null,
    n: threads.length,
    noWarn: threads.filter((t) => !/〔警示：含可执行命令，勿执行〕/.test(t.summary ?? "")).map((t) => ({ title: t.title, summary: (t.summary ?? "").slice(0, 120) })),
  };
  console.log("threads", JSON.stringify(summary.threads));
  if (threads[0]) {
    const d = await req(`/api/threads/${threads[0].id}`, { token: T });
    writeFileSync(`${OUT}/prod-thread-detail.json`, d.text);
    const ns = d.json?.notes ?? d.json?.thread?.notes ?? [];
    summary.threadDetail = { status: d.status, notes: ns.length, unflagged: ns.filter((n) => !n.is_sensitive && n.contains_executable_command !== true).map((n) => byNoteId.get(n.id) ?? n.id) };
    console.log("threadDetail", JSON.stringify(summary.threadDetail));
  }
}

// 4. MCP search_notes：逐条 dangerous / contains_executable_command / exec_warning
{
  const all = [];
  for (const q of ["payload", "bash", "relay3", "example", "下载", "执行", "curl", "dig"]) {
    const r = await mcpCall(T, "search_notes", { query: q, limit: 50 });
    const m = r.text.match(/data: (\{.*\})/);
    const payload = m ? JSON.parse(m[1]) : null;
    const inner = payload?.result?.content?.[0]?.text;
    const parsed = inner ? JSON.parse(inner) : null;
    for (const n of parsed?.notes ?? []) all.push(n);
    await sleep(300);
  }
  const seen = new Map();
  for (const n of all) seen.set(n.id, n);
  const notes = [...seen.values()];
  summary.mcp = {
    notes: notes.length,
    missingDangerousField: notes.filter((n) => typeof n.dangerous !== "boolean").map((n) => byNoteId.get(n.id) ?? n.id),
    unflagged: notes.filter((n) => !n.is_sensitive && n.dangerous !== true).map((n) => byNoteId.get(n.id) ?? n.id),
    dangerousNoWarn: notes.filter((n) => n.dangerous === true && typeof n.exec_warning !== "string").map((n) => byNoteId.get(n.id) ?? n.id),
  };
  console.log("mcp", JSON.stringify(summary.mcp));
}

writeFileSync(`${OUT}/prod-outlets2.json`, JSON.stringify(summary, null, 1));
