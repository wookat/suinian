/**
 * /api/ask retrieval-quality eval (R54) — repeatable against a live or local API.
 *
 * Usage:
 *   SUINIAN_API_BASE=https://suinian-api.zalize.com npx tsx scripts/ask-eval.ts [--keep] [--holdout] [--only=q01,q02]
 *
 * By default it registers a throwaway QA account (qa-r79-eval-*), seeds the
 * golden dataset (scripts/ask-eval-data.ts) via /api/import (markdown with
 * backdated created_at), patches each note with its golden category/tags/title
 * (which also triggers embedding + graph extraction), waits for semantic
 * recall to become ready, runs every question through /api/ask and scores
 * recall / citation / refusal per category. The account is deleted afterwards
 * (DELETE /api/auth/me) unless --keep is passed.
 *
 * --holdout includes holdout questions in the report (use only for the final
 * before/after comparison, never while tuning).
 */

import { NOTES, QUESTIONS, PREFIX, type EvalNote, type EvalQuestion } from "./ask-eval-data";

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const KEEP = process.argv.includes("--keep");
const HOLDOUT = process.argv.includes("--holdout");
const NOGRAPH = process.argv.includes("--nograph"); // A/B：关闭 GraphRAG 扩展对比图谱贡献
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) ?? "").replace("--only=", "").split(",").filter(Boolean);

let token = process.env.SUINIAN_TOKEN ?? "";
let createdAccount = false;
let accountName = "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init?.headers },
    });
    if (res.status === 429 && attempt < 3) {
      const wait = 65_000 * (attempt + 1);
      console.log(`  429 rate-limited on ${path}, retrying in ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    // 种子 PATCH 与异步分拣写回的 CAS 竞态（R180）：服务端 SELECT→UPDATE 窗口内
    // 分拣落盘会返 409。eval 里没有真正的多设备冲突，重发同一黄金元数据即可
    //（manual_override 落盘后分拣不再覆盖），退避重试消除长期抖动误报。
    if (res.status === 409 && attempt < 5) {
      const wait = 2_000 * (attempt + 1);
      console.log(`  409 triage race on ${path}, retrying in ${wait / 1000}s...`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backdatedIso(daysAgo: number): string {
  // Shanghai-local date + a fixed mid-day time keeps "N days ago" stable
  const d = new Date(Date.now() + 8 * 3600_000 - daysAgo * 86400_000);
  return `${d.toISOString().slice(0, 10)} 12:00`;
}

/** Golden notes → one markdown import file with backdated created_at lines. */
function buildImportMarkdown(): string {
  return NOTES.map((n) => `${backdatedIso(n.daysAgo)}\n${n.content}`).join("\n\n---\n\n");
}

type NoteJson = { id: string; content: string; title: string | null; is_sensitive: boolean };

async function listAllNotes(): Promise<NoteJson[]> {
  const out: NoteJson[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const qs: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const res: { notes: NoteJson[]; next_cursor: string | null } = await api(`/api/notes?limit=100${qs}`);
    out.push(...res.notes);
    cursor = res.next_cursor;
    if (!cursor) break;
  }
  return out;
}

async function ensureAccount(): Promise<void> {
  if (token) return;
  const name = `qa-r79-eval-${Math.random().toString(36).slice(2, 8)}`;
  const password = `Eval-${crypto.randomUUID()}`;
  const res = await api<{ api_token: string; user: { id: string } }>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, password }),
  });
  token = res.api_token;
  createdAccount = true;
  accountName = name;
  console.log(`registered eval account ${res.user.id} (${name})`);
}

/** Seed golden notes and return note-key → note-id. */
async function seed(): Promise<Map<string, string>> {
  const md = buildImportMarkdown();
  const stats = await api<{ imported: number; skipped: number }>("/api/import", {
    method: "POST",
    body: JSON.stringify({ source: "markdown", content: md }),
  });
  console.log(`import: imported=${stats.imported} skipped=${stats.skipped} (of ${NOTES.length})`);

  const notes = await listAllNotes();
  const idByKey = new Map<string, string>();
  for (const n of NOTES) {
    const row = notes.find((x) => x.content === n.content);
    if (!row) throw new Error(`seed: note not found after import: ${n.key}`);
    idByKey.set(n.key, row.id);
  }
  // golden category/tags/title (deterministic, marks manual_override so the
  // cron never re-sorts); patching content also triggers embedding + graph
  for (const n of NOTES) {
    const id = idByKey.get(n.key)!;
    await api(`/api/notes/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        content: n.content,
        title: n.title,
        category: n.category,
        tags: n.tags ?? [],
        ...(n.sensitive ? { is_sensitive: true } : {}),
      }),
    });
    await sleep(150); // let waitUntil pipelines breathe
  }
  console.log(`patched ${NOTES.length} notes with golden metadata`);
  return idByKey;
}

/** Wait until semantic recall covers the seeded notes (embeddings are async). */
async function waitForEmbeddings(): Promise<void> {
  // probe with a paraphrase that shares no keywords with the target note
  const probe = "冲泡咖啡的滤纸器具哪个好";
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    const res = await api<{ notes: (NoteJson & { match?: string })[] }>(
      `/api/notes?q=${encodeURIComponent(probe)}&limit=20`
    );
    if ((res.notes ?? []).some((n) => n.match === "semantic" || n.match === "both")) {
      console.log(`embeddings ready after ~${(i + 1) * 3}s`);
      return;
    }
  }
  console.warn("warning: semantic probe never matched — embeddings may be incomplete");
}

/** Wait until async triage has extracted amounts for the finance seed notes
 * (财务极值/聚合类问题依赖 amount 列，triage 队列慢时会整类误判「无金额」). */
async function waitForAmounts(idByKey: Map<string, string>): Promise<void> {
  const financeKeys = NOTES.filter((n) => n.category === "expense" || n.category === "income").map((n) => n.key);
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const res: { notes: (NoteJson & { amount?: number | null })[] } = await api("/api/notes?limit=100");
    const byId = new Map(res.notes.map((n) => [n.id, n]));
    const missing = financeKeys.filter((k) => byId.get(idByKey.get(k)!)?.amount == null);
    if (missing.length === 0) {
      console.log(`amounts ready after ~${(i + 1) * 5}s`);
      return;
    }
    if (i % 6 === 5) console.log(`  waiting for amounts: ${missing.join(",")}`);
  }
  console.warn("warning: some finance notes never got an amount — extreme/agg questions may misjudge");
}

interface AskResponse {
  answer: string;
  references: { index: number; note_id: string }[];
  notes: { id: string }[];
}

const REFUSAL_RE = /没有?找到|没有相关|没有记录|未找到|找不到|没记过|没有这方面|没有?提到|未提及/;

interface QResult {
  q: EvalQuestion;
  refKeys: string[];
  citedKeys: string[];
  recallHit: boolean;
  allHit: boolean;
  citeHit: boolean;
  refusalOk: boolean | null;
  forbidOk: boolean;
  pass: boolean;
  answer: string;
}

async function runQuestion(q: EvalQuestion, idByKey: Map<string, string>): Promise<QResult> {
  const keyById = new Map([...idByKey.entries()].map(([k, v]) => [v, k]));
  const res = await api<AskResponse>("/api/ask", {
    method: "POST",
    body: JSON.stringify({ question: q.question, ...(q.history ? { history: q.history } : {}), ...(NOGRAPH ? { graph: false } : {}) }),
  });
  const refKeys = res.references.map((r) => keyById.get(r.note_id) ?? `?${r.note_id.slice(0, 6)}`);
  // keys actually cited in the answer text ([n] present)
  const citedIdx = new Set([...res.answer.matchAll(/[\[［](\d{1,2})[\]］]/g)].map((m) => parseInt(m[1], 10)));
  const citedKeys = res.references.filter((r) => citedIdx.has(r.index)).map((r) => keyById.get(r.note_id) ?? "?");

  const recallHit = !q.expectAny || q.expectAny.some((k) => refKeys.includes(k));
  const allHit = !q.expectAll || q.expectAll.every((k) => refKeys.includes(k));
  const citeHit = !q.expectAny || citedKeys.length === 0 ? recallHit : q.expectAny.some((k) => citedKeys.includes(k));
  // a refusal must be explicit AND must not dump the whole recall context as
  // references — at most 3 "相近建议" cards
  const refusalOk =
    q.expectRefusal === undefined ? null : REFUSAL_RE.test(res.answer) && res.references.length <= 3;
  const forbidden = (q.forbid ?? []).filter((k) => refKeys.includes(k));
  const forbidOk = forbidden.length === 0 && !(q.forbid ?? []).some(() => /qa-r79-demo-9x7/.test(res.answer));
  const answerOk =
    (q.expectAnswerContains ?? []).every((s) => res.answer.includes(s)) &&
    !(q.forbidAnswerContains ?? []).some((s) => res.answer.includes(s));
  const pass = recallHit && allHit && (refusalOk ?? true) && forbidOk && answerOk;
  return { q, refKeys, citedKeys, recallHit, allHit, citeHit, refusalOk, forbidOk, pass, answer: res.answer };
}

function report(results: QResult[], label: string): void {
  console.log(`\n===== ${label} =====`);
  const byCat = new Map<string, QResult[]>();
  for (const r of results) {
    byCat.set(r.q.category, [...(byCat.get(r.q.category) ?? []), r]);
  }
  for (const [cat, rs] of byCat) {
    const ok = rs.filter((r) => r.pass).length;
    console.log(`  ${cat}: ${ok}/${rs.length}`);
  }
  const total = results.filter((r) => r.pass).length;
  console.log(`  TOTAL: ${total}/${results.length} (${((100 * total) / Math.max(1, results.length)).toFixed(0)}%)`);
}

async function cleanup(): Promise<void> {
  if (KEEP) {
    console.log("--keep: leaving eval account/data in place");
    return;
  }
  if (createdAccount) {
    // 删号也要重试（R180）：中途 abort 后绝不留下 QA 账号/数据
    for (let attempt = 0; ; attempt++) {
      try {
        await api("/api/auth/me", { method: "DELETE" });
        break;
      } catch (e) {
        if (attempt >= 2) {
          console.error(`FAILED to delete eval account ${accountName} — delete it manually!`);
          throw e;
        }
        await sleep(5_000);
      }
    }
    console.log("deleted eval account (cascade removed all data)");
  } else {
    // token was provided: only delete the notes this run created
    const notes = await listAllNotes();
    const mine = notes.filter((n) => n.content.startsWith(PREFIX) || n.title?.startsWith(PREFIX));
    for (const n of mine) await api(`/api/notes/${n.id}`, { method: "DELETE" });
    console.log(`deleted ${mine.length} ${PREFIX} notes`);
  }
}

async function main() {
  await ensureAccount();
  try {
    const idByKey = await seed();
    await waitForEmbeddings();
    await waitForAmounts(idByKey);
    // give graph extraction a little more time (AI calls per note)
    await sleep(15_000);

    const questions = QUESTIONS.filter((q) => (ONLY.length > 0 ? ONLY.includes(q.id) : HOLDOUT || !q.holdout));
    const results: QResult[] = [];
    for (const q of questions) {
      const r = await runQuestion(q, idByKey);
      results.push(r);
      const flags = [
        r.recallHit ? "recall✅" : "recall❌",
        q.expectAll ? (r.allHit ? "all✅" : "all❌") : "",
        r.refusalOk === null ? "" : r.refusalOk ? "refuse✅" : "refuse❌",
        r.forbidOk ? "" : "FORBIDDEN-LEAK❌",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(
        `${r.pass ? "✅" : "❌"} ${q.id} [${q.category}]${q.holdout ? " (holdout)" : ""} ${q.question}\n` +
          `    ${flags} | refs=[${r.refKeys.join(",")}]\n` +
          `    answer: ${r.answer.replace(/\n/g, " ").slice(0, 160)}`
      );
    }
    report(results.filter((r) => !r.q.holdout), "DEV SET");
    if (HOLDOUT) report(results.filter((r) => r.q.holdout), "HOLDOUT SET");
    if (HOLDOUT) report(results, "ALL");
  } finally {
    await cleanup().catch((e) => console.error("cleanup failed:", e));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
