import type { Env, NoteRow } from "./types";

/** bge-m3 cosine similarity above which two ideas join the same thread directly. */
const SIM_JOIN = 0.76;
/** Similarity above which DeepSeek is asked to confirm a borderline match. */
const SIM_CANDIDATE = 0.5;
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
    if (!Array.isArray(v) || v.length === 0) {
      console.error("threads: embed returned no vector", JSON.stringify(res).slice(0, 200));
      return null;
    }
    return v;
  } catch (err) {
    console.error("threads: embed failed", err);
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

async function deepseekPickNumber(env: Env, system: string, user: string, max: number): Promise<number | null> {
  if (!env.DEEPSEEK_API_KEY) return null;
  try {
    const res = await fetch(`${env.DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0,
        max_tokens: 10,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      console.error("threads: deepseek pick failed", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const n = parseInt((data.choices?.[0]?.message?.content ?? "").trim(), 10);
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  } catch (err) {
    console.error("threads: deepseek pick error", err);
    return null;
  }
}

/** DeepSeek fallback: pick an existing thread (by title) or none for a new idea. */
async function deepseekPickThread(
  env: Env,
  content: string,
  threads: { id: string; title: string }[]
): Promise<string | null> {
  if (threads.length === 0) return null;
  const list = threads.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
  const n = await deepseekPickNumber(
    env,
    "下面是若干思考线索的标题，以及一条新想法。若新想法明显属于其中某条线索（同一主题的延续），只输出对应序号数字；否则输出 0。只输出数字。",
    `线索：\n${list}\n\n新想法：${content.slice(0, 500)}`,
    threads.length
  );
  return n !== null && n >= 1 ? threads[n - 1].id : null;
}

/** DeepSeek: pick a same-topic note among recent unthreaded ideas (cold start: no threads yet). */
async function deepseekPickNote(
  env: Env,
  content: string,
  notes: { id: string; title: string | null; content: string }[]
): Promise<string | null> {
  if (notes.length === 0) return null;
  const list = notes.map((n, i) => `${i + 1}. ${(n.title || n.content).slice(0, 100)}`).join("\n");
  const n = await deepseekPickNumber(
    env,
    "下面是若干历史想法，以及一条新想法。若新想法与其中某条明显是同一主题的延续（可以串成同一条思考线索），只输出对应序号数字；否则输出 0。只输出数字。",
    `历史想法：\n${list}\n\n新想法：${content.slice(0, 500)}`,
    notes.length
  );
  return n !== null && n >= 1 ? notes[n - 1].id : null;
}

/** DeepSeek: confirm whether two idea snippets are the same topic (borderline embedding match). */
async function deepseekConfirmPair(env: Env, a: string, b: string): Promise<boolean> {
  const n = await deepseekPickNumber(
    env,
    "判断下面两条想法是否属于同一主题（可以串成同一条思考线索）。是则输出 1，否则输出 0。只输出数字。",
    `想法A：${a.slice(0, 400)}\n\n想法B：${b.slice(0, 400)}`,
    1
  );
  return n === 1;
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
      let best: { id: string; thread_id: string | null; title: string | null; content: string; sim: number } | null =
        null;
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
        if (!best || sim > best.sim)
          best = { id: r.id, thread_id: r.thread_id, title: r.title, content: r.content, sim };
      }
      if (best) {
        const direct = best.sim >= SIM_JOIN;
        const confirmed =
          !direct &&
          best.sim >= SIM_CANDIDATE &&
          (await deepseekConfirmPair(env, note.title || note.content, best.title || best.content));
        console.log(
          `threads: cluster note=${note.id} best=${best.id} sim=${best.sim.toFixed(3)} direct=${direct} confirmed=${confirmed}`
        );
        if (direct || confirmed) {
          let threadId = best.thread_id;
          if (!threadId) {
            threadId = await newThread(env, note.user_id, best.title || note.title || note.content.slice(0, 20));
            await attachNoteToThread(env, best.id, threadId);
            console.log(`threads: created thread ${threadId} for notes ${best.id}, ${note.id}`);
          }
          await attachNoteToThread(env, note.id, threadId);
          return;
        }
      } else {
        console.log(`threads: cluster note=${note.id} no comparable idea notes`);
      }
      // borderline/no embedding match: still try DeepSeek against existing thread titles
      const picked = await pickThreadByDeepseek(env, note);
      if (picked) await attachNoteToThread(env, note.id, picked);
      return;
    }
    // no embedding available: DeepSeek-only fallback (existing threads, then cold-start pairing)
    console.log(`threads: no embedding for note=${note.id}, using deepseek fallback`);
    const picked = await pickThreadByDeepseek(env, note);
    if (picked) {
      await attachNoteToThread(env, note.id, picked);
      return;
    }
    // cold start: no thread matched (or none exist) — pair with a recent unthreaded idea
    const { results: loose } = await env.DB.prepare(
      `SELECT id, title, content FROM notes
       WHERE user_id = ? AND category = 'idea' AND thread_id IS NULL AND id != ?
         AND created_at >= datetime('now', '-90 days')
       ORDER BY created_at DESC LIMIT 30`
    )
      .bind(note.user_id, note.id)
      .all<{ id: string; title: string | null; content: string }>();
    const mate = await deepseekPickNote(env, note.content, loose ?? []);
    if (mate) {
      const m = (loose ?? []).find((n) => n.id === mate)!;
      const threadId = await newThread(env, note.user_id, m.title || note.title || note.content.slice(0, 20));
      await attachNoteToThread(env, mate, threadId);
      await attachNoteToThread(env, note.id, threadId);
      console.log(`threads: cold-start created thread ${threadId} for notes ${mate}, ${note.id}`);
    }
  } catch (err) {
    // clustering must never break note ingestion, but always leave a trace
    console.error(`threads: clusterNote failed for note=${note.id}`, err);
  }
}

async function pickThreadByDeepseek(env: Env, note: NoteRow): Promise<string | null> {
  const { results: threads } = await env.DB.prepare(
    "SELECT id, title FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30"
  )
    .bind(note.user_id)
    .all<{ id: string; title: string }>();
  return deepseekPickThread(env, note.content, threads ?? []);
}

/**
 * Full re-cluster of a user's idea notes from the last 90 days: detach them
 * from threads, drop the resulting empty threads, then run clusterNote over
 * each idea in chronological order.
 */
export async function rebuildThreads(env: Env, userId: string): Promise<{ ideas: number; threads: number }> {
  const { results: ideas } = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND category = 'idea'
       AND created_at >= datetime('now', '-90 days')
     ORDER BY created_at ASC LIMIT 500`
  )
    .bind(userId)
    .all<NoteRow>();
  const rows = ideas ?? [];
  await env.DB.prepare(
    `UPDATE notes SET thread_id = NULL WHERE user_id = ? AND category = 'idea'
       AND created_at >= datetime('now', '-90 days')`
  )
    .bind(userId)
    .run();
  await env.DB.prepare(
    "DELETE FROM threads WHERE user_id = ? AND id NOT IN (SELECT DISTINCT thread_id FROM notes WHERE thread_id IS NOT NULL)"
  )
    .bind(userId)
    .run();
  for (const n of rows) {
    await clusterNote(env, { ...n, thread_id: null });
  }
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM threads WHERE user_id = ? AND note_count > 0")
    .bind(userId)
    .first<{ c: number }>();
  console.log(`threads: rebuild for user=${userId} ideas=${rows.length} threads=${cnt?.c ?? 0}`);
  return { ideas: rows.length, threads: cnt?.c ?? 0 };
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
