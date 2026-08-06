/**
 * Triage quality regression eval — 10 fixed cases against a live (or local) API.
 *
 * Usage:
 *   SUINIAN_API_BASE=https://suinian-api.zalize.com SUINIAN_TOKEN=xxx npx tsx scripts/triage-eval.ts
 *
 * Creates [QA-EVAL] prefixed notes, waits for async triage, scores
 * category / todo_due / tag-noise expectations, prints accuracy, then
 * deletes every note it created.
 */

const API = process.env.SUINIAN_API_BASE ?? "https://suinian-api.zalize.com";
const TOKEN = process.env.SUINIAN_TOKEN ?? "";
if (!TOKEN) {
  console.error("SUINIAN_TOKEN is required");
  process.exit(1);
}

const PREFIX = "[QA-EVAL]";

type NoteJson = {
  id: string;
  content: string;
  category: string | null;
  tags: string[];
  title: string | null;
  todo_due: string | null;
};

function shanghaiIso(offsetDays = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

function nextMondayIso(): string {
  const dow = new Date(Date.now() + 8 * 3600_000).getUTCDay();
  return shanghaiIso((8 - dow) % 7 || 7);
}

function nearestFridayIso(): string {
  const dow = new Date(Date.now() + 8 * 3600_000).getUTCDay();
  return shanghaiIso((5 - dow + 7) % 7);
}

interface EvalCase {
  content: string;
  category: "idea" | "todo" | "collect" | "data";
  /** expected due date (YYYY-MM-DD part) or null for "no due"; undefined = don't check */
  due?: string | null;
  /** tags must not contain any of these substrings */
  forbiddenTagParts?: string[];
}

const CASES: EvalCase[] = [
  { content: `${PREFIX} 下周一晚上8点提醒我给客户回邮件`, category: "todo", due: nextMondayIso() },
  { content: `${PREFIX} 明天上午10点半和设计师对 UI 稿`, category: "todo", due: shanghaiIso(1) },
  { content: `${PREFIX} 周五下午3点交季度报告给老板`, category: "todo", due: nearestFridayIso() },
  { content: `${PREFIX} 回头把冰箱滤芯换了`, category: "todo", due: null },
  { content: `${PREFIX} 公司报销流程：先在 OA 提单，再贴发票给财务`, category: "data" },
  { content: `${PREFIX} 9月1号起各部门预算表改用新模板，找行政领新版`, category: "data" },
  { content: `${PREFIX} https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API 讲 Service Worker 的文档`, category: "collect" },
  { content: `${PREFIX} 突然想到：碎念的周报可以做成邮件推送，让用户被动回顾`, category: "idea" },
  { content: `${PREFIX} 【灵感】给时间流加一个按月折叠的视图`, category: "idea", forbiddenTagParts: ["灵感】", "【"] },
  { content: `${PREFIX} 家里 Wi-Fi 密码改成了 hunter2-demo`, category: "data" },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init?.headers },
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const created: string[] = [];
  try {
    for (const c of CASES) {
      const { note } = await api<{ note: NoteJson }>("/api/notes", {
        method: "POST",
        body: JSON.stringify({ source: "api", raw_type: "text", content: c.content }),
      });
      created.push(note.id);
    }
    console.log(`created ${created.length} notes, waiting for triage...`);

    // poll until every note has a category (max ~90s)
    let notes: NoteJson[] = [];
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const res = await api<{ notes: NoteJson[] }>(`/api/notes?q=${encodeURIComponent(PREFIX)}&limit=50`);
      notes = res.notes.filter((n) => created.includes(n.id));
      if (notes.length === created.length && notes.every((n) => n.category)) break;
    }

    let catOk = 0;
    let dueChecked = 0;
    let dueOk = 0;
    let tagOk = 0;
    let tagChecked = 0;
    for (const c of CASES) {
      const n = notes.find((x) => x.content === c.content);
      const cat = n?.category ?? "(unsorted)";
      const catPass = cat === c.category;
      if (catPass) catOk++;
      let line = `${catPass ? "✅" : "❌"} [${cat}${catPass ? "" : ` ≠ ${c.category}`}] ${c.content.slice(0, 40)}`;
      if (c.due !== undefined) {
        dueChecked++;
        const gotDate = n?.todo_due ? n.todo_due.slice(0, 10) : null;
        const duePass = gotDate === c.due;
        if (duePass) dueOk++;
        line += ` | due ${duePass ? "✅" : "❌"} got=${n?.todo_due ?? "null"} want=${c.due ?? "null"}`;
      }
      const noisy = (n?.tags ?? []).filter((t) =>
        [...(c.forbiddenTagParts ?? []), "QA", "EVAL"].some((p) => t.includes(p))
      );
      tagChecked++;
      if (noisy.length === 0) tagOk++;
      else line += ` | tags 污染 ❌ ${JSON.stringify(noisy)}`;
      console.log(line);
    }
    console.log(
      `\ncategory: ${catOk}/${CASES.length}  todo_due: ${dueOk}/${dueChecked}  tags 无前缀污染: ${tagOk}/${tagChecked}`
    );
  } finally {
    for (const id of created) {
      await api(`/api/notes/${id}`, { method: "DELETE" }).catch((e) => console.error(`cleanup ${id} failed:`, e));
    }
    console.log(`cleaned up ${created.length} eval notes`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
