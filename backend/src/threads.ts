import type { Env, NoteRow } from "./types";

const SIM_THRESHOLD = 0.78;
const EMBED_MODEL = "@cf/baai/bge-m3";

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embed(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    const res = (await env.AI.run(EMBED_MODEL, { text: [text.slice(0, 1000)] })) as {
      data?: number[][];
    };
    const v = res?.data?.[0];
    return Array.isArray(v) && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

async function saveEmbedding(env: Env, noteId: string, vector: number[]): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO note_embeddings (note_id, vector) VALUES (?, ?)"
  )
    .bind(noteId, JSON.stringify(vector))
    .run();
}

async function newThread(env: Env, userId: string, title: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO threads (id, user_id, title, note_count) VALUES (?, ?, ?, 0)"
  )
    .bind(id, userId, title.slice(0, 50) || "未命名线索")
    .run();
  return id;
}

async function attachNoteToThread(env: Env, noteId: string, threadId: string): Promise<void> {
  await env.DB.prepare("UPDATE notes SET thread_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(threadId, noteId)
    .run();
  await env.DB.prepare(
    "UPDATE threads SET note_count = (SELECT COUNT(*) FROM notes WHERE thread_id = ?), updated_at = datetime('now') WHERE id = ?"
  )
    .bind(threadId, threadId)
    .run();
}

/** DeepSeek fallback: pick an existing thread (by title) or none for a new idea. */
async function deepseekPickThread(
  env: Env,
  content: string,
  threads: { id: string; title: string }[]
): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY || threads.length === 0) return null;
  try {
    const list = threads.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
    const res = await fetch(`${env.DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0,
        max_tokens: 10,
        messages: [
          {
            role: "system",
            content:
              "下面是若干思考线索的标题，以及一条新想法。若新想法明显属于其中某条线索（同一主题的延续），只输出对应序号数字；否则输出 0。只输出数字。",
          },
          { role: "user", content: `线索：\n${list}\n\n新想法：${content.slice(0, 500)}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const n = parseInt((data.choices?.[0]?.message?.content ?? "0").trim(), 10);
    return n >= 1 && n <= threads.length ? threads[n - 1].id : null;
  } catch {
    return null;
  }
}

/**
 * Cluster a newly-saved idea note into a thread: embed it, compare with idea
 * notes from the last 90 days, and join/create a thread on high similarity.
 * Falls back to a DeepSeek title-match when Workers AI is unavailable.
 * Never throws.
 */
export async function clusterNote(env: Env, note: NoteRow): Promise<void> {
  try {
    if (note.category !== "idea") return;
    const vector = await embed(env, `${note.title ?? ""}\n${note.content}`);
    if (vector) {
      await saveEmbedding(env, note.id, vector);
      const { results } = await env.DB.prepare(
        `SELECT n.id, n.thread_id, n.title, n.content, e.vector FROM notes n
         LEFT JOIN note_embeddings e ON e.note_id = n.id
         WHERE n.user_id = ? AND n.category = 'idea' AND n.id != ?
           AND n.created_at >= datetime('now', '-90 days')
         ORDER BY n.created_at DESC LIMIT 200`
      )
        .bind(note.user_id, note.id)
        .all<{ id: string; thread_id: string | null; title: string | null; content: string; vector: string | null }>();
      let best: { id: string; thread_id: string | null; title: string | null; sim: number } | null = null;
      let backfilled = 0;
      for (const r of results ?? []) {
        let v: number[] | null = null;
        if (r.vector) {
          try {
            v = JSON.parse(r.vector) as number[];
          } catch {
            v = null;
          }
        } else if (backfilled < 20) {
          // lazily embed older idea notes that predate the embeddings table
          backfilled++;
          v = await embed(env, `${r.title ?? ""}\n${r.content}`);
          if (v) await saveEmbedding(env, r.id, v);
        }
        if (!v) continue;
        const sim = cosineSim(vector, v);
        if (!best || sim > best.sim) best = { id: r.id, thread_id: r.thread_id, title: r.title, sim };
      }
      if (best && best.sim >= SIM_THRESHOLD) {
        let threadId = best.thread_id;
        if (!threadId) {
          threadId = await newThread(env, note.user_id, best.title || note.title || note.content.slice(0, 20));
          await attachNoteToThread(env, best.id, threadId);
        }
        await attachNoteToThread(env, note.id, threadId);
      }
      return;
    }
    // fallback: DeepSeek picks among recent thread titles
    const { results: threads } = await env.DB.prepare(
      "SELECT id, title FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30"
    )
      .bind(note.user_id)
      .all<{ id: string; title: string }>();
    const picked = await deepseekPickThread(env, note.content, threads ?? []);
    if (picked) await attachNoteToThread(env, note.id, picked);
  } catch {
    /* clustering must never break note ingestion */
  }
}

/** Daily cron: refresh title/summary/note_count of every thread from its notes. */
export async function refreshThreads(env: Env): Promise<void> {
  const { results: threads } = await env.DB.prepare(
    "SELECT id, user_id, title FROM threads"
  ).all<{ id: string; user_id: string; title: string }>();
  for (const t of threads ?? []) {
    try {
      const { results: notes } = await env.DB.prepare(
        "SELECT title, content, created_at FROM notes WHERE thread_id = ? ORDER BY created_at ASC LIMIT 50"
      )
        .bind(t.id)
        .all<{ title: string | null; content: string; created_at: string }>();
      const rows = notes ?? [];
      await env.DB.prepare(
        "UPDATE threads SET note_count = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(rows.length, t.id)
        .run();
      if (rows.length === 0 || !env.DEEPSEEK_API_KEY) continue;
      const digest = rows
        .map((n, i) => `${i + 1}. (${n.created_at.slice(0, 10)}) ${(n.title || n.content).slice(0, 200)}`)
        .join("\n");
      const res = await fetch(`${env.DEEPSEEK_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: "deepseek-chat",
          temperature: 0.3,
          max_tokens: 300,
          messages: [
            {
              role: "system",
              content:
                '以下是同一条思考线索里按时间排列的碎片。输出严格 JSON {"title":"<=20字的线索标题","summary":"<=120字的线索脉络总结"}，只输出 JSON。',
            },
            { role: "user", content: digest },
          ],
        }),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content ?? "";
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const obj = JSON.parse(m[0]) as { title?: string; summary?: string };
      if (obj.title || obj.summary) {
        await env.DB.prepare(
          "UPDATE threads SET title = ?, summary = ?, updated_at = datetime('now') WHERE id = ?"
        )
          .bind((obj.title || t.title).slice(0, 50), obj.summary ?? null, t.id)
          .run();
      }
    } catch {
      /* per-thread failures shouldn't stop the sweep */
    }
  }
}
