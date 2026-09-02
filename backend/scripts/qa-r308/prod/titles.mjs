// R308 标题出口复测：危险笔记的 title 在 notes.list / 搜索 / Markdown 导出标题 / 备份 /
// 今日回顾 / MCP 中不许带出地址、路径、命令、编码串或正文回声。
// 用法：node prod/titles.mjs <danger|benign>
import { writeFileSync, readFileSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { req, mcpCall, API, UA } from "./lib.mjs";

const OUT = new URL("../out", import.meta.url).pathname;
const kind = process.argv[2];
const acct = JSON.parse(readFileSync(`${OUT}/prod-${kind}-account.json`, "utf8"));
const T = acct.token;
const byNoteId = new Map(Object.entries(acct.notes).map(([id, v]) => [v.note_id, id]));

const NEEDLES = [
  "payload.sh", "p.sh", "i.sh", "p.js", "p.py", "p.ps1", "p.tgz", "relay3", "evil", "c2.example.net",
  "bit.ly", "jsdelivr", "r2.cloudflarestorage", "NBSWY3DP", "eryl3", "ten.elpmaxe", "QED8WEX0", "bastion",
  "x.sock", "203.0.113", "3405803785", "0xCB007147", "2001:db8", "xn--", "gist.github", "pastebin",
  "github.io", "vercel.app", "githubusercontent", "attacker", "P@ssw0rd", "\\162\\145",
  "deploy.sh", "setup.sh", "agent.sh", "beacon.sh", "x.js", "a.ps1", "p.txt", "javascript:", "aHR0cHM6",
  "OJSWYYLZ", "uhodb3", ".-. . .-..", "\\x63\\x75", "rеlаy3", "🇷🇪🇱", "document.cookie",
  "relay3 점", "relay3 точка", "relay3 نقطة", "ay3.example.ne", "relay3.example.net", "/etc/passwd", "example.net", "example.com",
  "curl", "wget", "| sh", "|sh", "bash", "powershell", "nc ", "ping ",
];
const PLACEHOLDER = "含可执行命令的记录（已折叠）";
const fold = (s) => (s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const leakIn = (s) => NEEDLES.filter((n) => (s ?? "").includes(n));
const titleBad = (n) => {
  if (!n.title) return null;
  const leaks = leakIn(n.title);
  if (leaks.length) return `needle:${leaks.join("|")}`;
  const ft = fold(n.title);
  if (ft.length >= 8 && fold(n.content).includes(ft)) return "echo";
  return null;
};

const summary = {};

// 1. notes.list 全量
const all = [];
{
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const r = await req(`/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { token: T });
    const items = r.json?.items ?? r.json?.notes ?? [];
    all.push(...items);
    cursor = r.json?.next_cursor ?? r.json?.cursor ?? null;
    if (!cursor || items.length === 0) break;
  }
  const flagged = all.filter((n) => n.contains_executable_command === true && !n.is_sensitive);
  const bad = flagged.map((n) => ({ id: byNoteId.get(n.id) ?? n.id, why: titleBad(n), title: n.title })).filter((r) => r.why);
  summary.list = {
    total: all.length,
    flagged: flagged.length,
    flaggedWithTitle: flagged.filter((n) => n.title).length,
    flaggedTitleNull: flagged.filter((n) => !n.title).length,
    bad,
    unflaggedWithTitle: all.filter((n) => n.contains_executable_command !== true && !n.is_sensitive && n.title).length,
    unflaggedNoTitle: all.filter((n) => n.contains_executable_command !== true && !n.is_sensitive && !n.title).map((n) => byNoteId.get(n.id) ?? n.id),
  };
  console.log("list", JSON.stringify(summary.list));
}

// 2. 搜索（关键词命中危险笔记时返回的 title）
{
  const qs = kind === "danger" ? ["relay3", "curl", "passwd", "解码", "example"] : ["ping", "curl", "psql", "feed"];
  const bad = [];
  let hits = 0;
  for (const q of qs) {
    const r = await req(`/api/notes?q=${encodeURIComponent(q)}&limit=100`, { token: T });
    const items = r.json?.items ?? r.json?.notes ?? [];
    for (const n of items) {
      if (n.contains_executable_command !== true || n.is_sensitive) continue;
      hits++;
      const why = titleBad(n);
      if (why) bad.push({ q, id: byNoteId.get(n.id) ?? n.id, why, title: n.title });
    }
  }
  summary.search = { queries: qs, flaggedHits: hits, bad };
  console.log("search", JSON.stringify(summary.search));
}

// 3. Markdown 导出：### 标题行
{
  const r = await req(`/api/export?format=markdown`, { token: T, raw: true });
  const heads = r.text.split("\n").filter((l) => l.startsWith("### ") && /（[^）]+）$/.test(l));
  const flaggedIds = new Set(all.filter((n) => n.contains_executable_command === true && !n.is_sensitive).map((n) => n.id));
  const rows = heads.map((h) => {
    const id = h.match(/（([^）]+)）$/)?.[1];
    return { id, cid: byNoteId.get(id) ?? id, head: h.slice(4), flagged: flaggedIds.has(id) };
  });
  const flaggedRows = rows.filter((r) => r.flagged);
  const bad = flaggedRows.filter((r) => leakIn(r.head).length > 0).map((r) => ({ id: r.cid, head: r.head, leaks: leakIn(r.head) }));
  summary.exportMd = {
    status: r.status,
    headings: rows.length,
    flaggedHeadings: flaggedRows.length,
    placeholderHeadings: flaggedRows.filter((r) => r.head.startsWith(PLACEHOLDER)).length,
    bad,
  };
  writeFileSync(`${OUT}/prod-export-${kind}-titles.md`, r.text);
  console.log("exportMd", JSON.stringify(summary.exportMd));
}

// 4. 备份 notes.json title
{
  const res = await fetch(`${API}/api/backup`, { headers: { authorization: `Bearer ${T}`, "user-agent": UA } });
  const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const notes = JSON.parse(strFromU8(entries["notes.json"]));
  const flagged = notes.filter((n) => n.contains_executable_command === true && !n.is_sensitive);
  const bad = flagged.map((n) => ({ id: byNoteId.get(n.id) ?? n.id, why: titleBad(n), title: n.title })).filter((r) => r.why);
  summary.backup = { status: res.status, flagged: flagged.length, flaggedTitleNull: flagged.filter((n) => !n.title).length, bad };
  console.log("backup", JSON.stringify(summary.backup));
}

// 5. 今日回顾 note.title
{
  const r = await req(`/api/review/today`, { token: T });
  const items = r.json?.items ?? [];
  const flagged = items.filter((it) => it.note?.contains_executable_command === true);
  const bad = flagged.map((it) => ({ id: byNoteId.get(it.note.id) ?? it.note.id, why: titleBad(it.note), title: it.note.title })).filter((r) => r.why);
  summary.review = { status: r.status, items: items.length, flagged: flagged.length, bad };
  console.log("review", JSON.stringify(summary.review));
}

// 6. MCP search_notes
{
  const q = kind === "danger" ? "relay3" : "ping";
  const r = await mcpCall(T, "search_notes", { query: q, limit: 50 });
  const text = r.text;
  let notes = [];
  try {
    const body = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) : text;
    const rpc = JSON.parse(body);
    const inner = JSON.parse(rpc.result?.content?.[0]?.text ?? "{}");
    notes = inner.notes ?? [];
  } catch (e) {
    console.log("mcp parse fail", String(e).slice(0, 100), text.slice(0, 200));
  }
  const flagged = notes.filter((n) => n.dangerous === true);
  const bad = flagged.map((n) => ({ id: byNoteId.get(n.id) ?? n.id, why: titleBad(n), title: n.title })).filter((x) => x.why);
  summary.mcp = { notes: notes.length, flagged: flagged.length, bad, len: text.length };
  console.log("mcp", JSON.stringify(summary.mcp));
}

writeFileSync(`${OUT}/prod-titles-${kind}.json`, JSON.stringify(summary, null, 1));
