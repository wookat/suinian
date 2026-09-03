// P0-1 生产七出口 + 额外出口矩阵：写入 113 危险载体到 [QA-R310] 账号，逐出口核对标记。
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { register, postNote, req, mcpCall, sleep } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const STATE = `${OUT}/prod-danger-account.json`;
const carriers = JSON.parse(readFileSync(`${OUT}/carriers.json`, "utf8"));

let acct;
if (existsSync(STATE)) {
  acct = JSON.parse(readFileSync(STATE, "utf8"));
  console.log("reuse account", acct.name, "notes", Object.keys(acct.notes).length);
} else {
  acct = await register(`[QA-R310]d${Date.now().toString(36).slice(-5)}`);
  acct.notes = {};
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  console.log("registered", acct.name, acct.user_id);
}
const T = acct.token;

// 1. 写入（skip_triage 避免 AI 分拣改写；速率 <60/min）
for (const c of carriers) {
  if (acct.notes[c.id]) continue;
  const n = await postNote(T, c.text, { skip_triage: true });
  acct.notes[c.id] = { note_id: n.note?.id ?? n.id ?? null, flag_on_create: n.note?.contains_executable_command ?? n.contains_executable_command ?? null };
  writeFileSync(STATE, JSON.stringify(acct, null, 1));
  await sleep(1150);
}
console.log("posted", Object.keys(acct.notes).length);

const byNoteId = new Map(Object.entries(acct.notes).map(([id, v]) => [v.note_id, id]));
const rows = Object.fromEntries(carriers.map((c) => [c.id, { family: c.family, cat: c.cat, note_id: acct.notes[c.id].note_id, create: acct.notes[c.id].flag_on_create }]));

// 2. notes.list（分页拉全）
{
  let cursor = null;
  let seen = 0;
  for (let i = 0; i < 10; i++) {
    const r = await req(`/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: T });
    for (const n of r.json?.notes ?? []) {
      const id = byNoteId.get(n.id);
      if (!id) continue;
      seen++;
      rows[id].list = n.contains_executable_command === true;
      rows[id].list_fold = n.fold === true;
      rows[id].list_fold_reason = n.fold_reason ?? null;
      rows[id].list_title = n.title ?? null;
      rows[id].list_sensitive = n.is_sensitive === true;
    }
    cursor = r.json?.next_cursor ?? r.json?.cursor ?? null;
    if (!cursor) break;
  }
  console.log("notes.list seen", seen);
}

// 3. 搜索（每条用自身前 12 字符/关键 token 搜）
for (const c of carriers) {
  const q = c.text.replace(/\s+/g, " ").slice(0, 12);
  const r = await req(`/api/notes?q=${encodeURIComponent(q)}&limit=50`, { token: T });
  const hit = (r.json?.notes ?? []).find((n) => n.id === rows[c.id].note_id);
  rows[c.id].search = hit ? hit.contains_executable_command === true : null;
  rows[c.id].search_fold = hit ? hit.fold === true : null;
  await sleep(120);
}

// 4. 导出 md + json
{
  const md = await req(`/api/export?format=md`, { token: T, raw: true });
  writeFileSync(`${OUT}/prod-export.md`, md.text);
  const js = await req(`/api/export`, { token: T });
  writeFileSync(`${OUT}/prod-export.json`, js.text);
  // R310 P0-3：整体风险声明（响应头 + 文件头）
  rows.__global_risk = {
    md_header: md.headers.get("x-suinian-content-risk"),
    md_notice: /不保证逐条识别每一种危险内容/.test(md.text.slice(0, 1500)),
    json_header: js.headers.get("x-suinian-content-risk"),
    json_notice: typeof js.json?.content_risk_notice === "string" || /不保证逐条识别每一种危险内容/.test(js.text.slice(0, 3000)),
  };
  const jsNotes = new Map((js.json?.notes ?? []).map((n) => [n.id, n]));
  for (const c of carriers) {
    const n = jsNotes.get(rows[c.id].note_id);
    rows[c.id].export_json = n ? n.contains_executable_command === true : null;
    rows[c.id].export_json_fold = n ? n.fold === true : null;
    // md：按标题行里的笔记 id 定位该条，检查标题与下一条标题之间是否有警示行
    const idx = md.text.indexOf(`（${rows[c.id].note_id}）`);
    if (idx < 0) rows[c.id].export_md = null;
    else {
      const next = md.text.indexOf("\n### ", idx);
      const block = md.text.slice(idx, next < 0 ? undefined : next);
      rows[c.id].export_md = /含可执行命令\/危险指令/.test(block);
      rows[c.id].export_md_fold_warn = /含可执行命令\/危险指令|宽判据折叠|勿直接执行|请勿直接执行/.test(block);
      rows[c.id].export_md_redacted = /\[已加密内容\]/.test(block);
    }
  }
  const bk = await req(`/api/backup`, { token: T, raw: true });
  writeFileSync(`${OUT}/prod-backup.txt`, bk.text);
  rows.__backup = { status: bk.status, len: bk.text.length, risk_header: bk.headers.get("x-suinian-content-risk"), note: "ZIP 二进制，字段核对见 outlets2.mjs" };
}

// 5. 今日回顾 / 回收站 / 线索 / 周报 / 洞察
{
  const rv = await req(`/api/review/today`, { token: T });
  writeFileSync(`${OUT}/prod-review.json`, rv.text);
  rows.__review = { status: rv.status, items: (rv.json?.items ?? []).map((it) => ({ id: byNoteId.get(it.note?.id), flag: it.note?.contains_executable_command, fold: it.note?.fold, kind: it.kind })) };
  const tr = await req(`/api/notes/trash`, { token: T });
  rows.__trash_before = { status: tr.status, n: tr.json?.notes?.length };
  const th = await req(`/api/threads`, { token: T });
  writeFileSync(`${OUT}/prod-threads.json`, th.text);
  rows.__threads = { status: th.status, n: th.json?.threads?.length, text: th.text.slice(0, 500) };
  const rp = await req(`/api/reports`, { token: T });
  rows.__reports = { status: rp.status, text: rp.text.slice(0, 300) };
}

// 6. MCP search_notes
{
  const r = await mcpCall(T, "search_notes", { query: "payload", limit: 50 });
  writeFileSync(`${OUT}/prod-mcp-payload.txt`, r.text);
  const r2 = await mcpCall(T, "search_notes", { query: "bash", limit: 50 });
  writeFileSync(`${OUT}/prod-mcp-bash.txt`, r2.text);
  rows.__mcp = { status: r.status, hasExecNotice: /exec_notice/.test(r.text), hasFoldField: /\\?"fold\\?"\s*:/.test(r.text), hasGlobalNotice: /不保证逐条识别每一种危险内容|content_risk/.test(r.text + r2.text), len: r.text.length };
}

writeFileSync(`${OUT}/prod-outlets.json`, JSON.stringify(rows, null, 1));

// 汇总
const ids = carriers.map((c) => c.id);
const unflaggedList = ids.filter((id) => rows[id].list === false);
const unflaggedSearch = ids.filter((id) => rows[id].search === false);
const unflaggedExport = ids.filter((id) => rows[id].export_json === false);
const unflaggedMd = ids.filter((id) => rows[id].export_md === false);
const unfoldedList = ids.filter((id) => rows[id].list_fold === false && !rows[id].list_sensitive);
const unfoldedSearch = ids.filter((id) => rows[id].search_fold === false);
const unfoldedExport = ids.filter((id) => rows[id].export_json_fold === false);
const unwarnedMd = ids.filter((id) => rows[id].export_md_fold_warn === false);
const titleLeak = ids.filter((id) => rows[id].list_fold && rows[id].list_title && !/已折叠|含端点|含可执行/.test(rows[id].list_title));
console.log("R310 宽判据: list 未折叠:", unfoldedList.length, unfoldedList.join(","));
console.log("R310 宽判据: search 未折叠:", unfoldedSearch.length, unfoldedSearch.join(","));
console.log("R310 宽判据: export.json 未折叠:", unfoldedExport.length, unfoldedExport.join(","));
console.log("R310 宽判据: export.md 无警示:", unwarnedMd.length, unwarnedMd.join(","));
console.log("R310 折叠条标题非占位:", titleLeak.length, titleLeak.map((id) => `${id}:${rows[id].list_title}`).join(" | "));
console.log("R310 全局风险声明:", JSON.stringify(rows.__global_risk));
console.log("严判据（只影响折叠优先级） list 未标:", unflaggedList.length, unflaggedList.join(","));
console.log("search 未标:", unflaggedSearch.length, unflaggedSearch.join(","));
console.log("search 未命中:", ids.filter((id) => rows[id].search === null).length);
console.log("export.json 未标:", unflaggedExport.length, unflaggedExport.join(","));
console.log("export.md 无警示:", unflaggedMd.length, unflaggedMd.join(","));
console.log("export.md 未定位:", ids.filter((id) => rows[id].export_md === null).join(","));
console.log("backup", JSON.stringify(rows.__backup));
console.log("review", JSON.stringify(rows.__review).slice(0, 400));
console.log("threads", JSON.stringify(rows.__threads).slice(0, 300));
console.log("mcp", JSON.stringify(rows.__mcp));
