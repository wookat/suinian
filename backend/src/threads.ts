import type { Env, NoteRow } from "./types";
import { chatComplete } from "./ai";
import { findGraphThreadMate } from "./graph";

/** bge-m3 cosine similarity above which two ideas join the same thread directly. */
const SIM_JOIN = 0.76;
/**
 * Unified similarity floor above which the LLM is asked to confirm a
 * borderline match (R106, from the audit-r105 §3.2 A/B: on the same corpus a
 * 0.5 idea-side floor confirmed 11 mis-joined pairs — pair precision 59.3% —
 * while a uniform 0.62 floor reached 84.2% precision at unchanged 88.9%
 * recall). Applies to every pair (idea and collect alike) and to both the
 * request path and the frugal cron backfill.
 */
const SIM_CONFIRM_FLOOR = 0.62;
/** Categories that participate in thread clustering: thoughts and the articles they react to. */
export const THREAD_CATEGORIES = "('idea','collect')";
const EMBED_MODEL = "@cf/baai/bge-m3";

/** Same field mix as semantic.noteEmbedText, local to avoid an import cycle. */
function embedInput(n: Pick<NoteRow, "title" | "content" | "url_title" | "url_summary">): string {
  return [n.title, n.content, n.url_title, n.url_summary].filter(Boolean).join("\n");
}

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

async function loadStoredEmbedding(env: Env, noteId: string): Promise<number[] | null> {
  const row = await env.DB.prepare("SELECT vector FROM note_embeddings WHERE note_id = ?")
    .bind(noteId)
    .first<{ vector: string }>();
  if (!row?.vector) return null;
  try {
    const v = JSON.parse(row.vector) as number[];
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

/**
 * Generate the thread's title/summary from its notes via DeepSeek and persist
 * them. Called synchronously when clustering attaches a note (so a thread has
 * a one-line summary right away, not only after the daily cron) and reused by
 * the daily refresh. Never throws.
 */
export async function summarizeThread(env: Env, threadId: string, fallbackTitle?: string): Promise<void> {
  try {

    const { results: notes } = await env.DB.prepare(
      "SELECT title, content, created_at FROM notes WHERE thread_id = ? ORDER BY created_at ASC LIMIT 50"
    )
      .bind(threadId)
      .all<{ title: string | null; content: string; created_at: string }>();
    const rows = notes ?? [];
    if (rows.length === 0) return;
    const digest = rows
      .map((n, i) => `${i + 1}. (${n.created_at.slice(0, 10)}) ${(n.title || n.content).slice(0, 200)}`)
      .join("\n");
    const text = await chatComplete(env, {
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            '以下是同一条思考线索里按时间排列的碎片。输出严格 JSON {"title":"<=20字的线索标题","summary":"<=120字的线索脉络总结"}，只输出 JSON。要求：标题必须概括全部碎片共同的主题，用碎片中实际出现的关键词组成，禁止使用「日常工作总结」「一些想法」这类任何内容都适用的泛化标题；summary 要讲出想法从第一条到最后一条如何递进/演变（谁引出谁、哪里转向），不许把各条标题逗号串联了事。',
        },
        { role: "user", content: digest },
      ],
    });
    if (!text) return;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return;
    const obj = JSON.parse(m[0]) as { title?: string; summary?: string };
    if (obj.title || obj.summary) {
      await env.DB.prepare(
        "UPDATE threads SET title = ?, summary = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind((obj.title || fallbackTitle || "未命名线索").slice(0, 50), obj.summary ?? null, threadId)
        .run();
    }
  } catch (err) {
    console.error(`threads: summarizeThread failed for thread=${threadId}`, err);
  }
}

export async function attachNoteToThread(env: Env, noteId: string, threadId: string): Promise<void> {
  const prev = await env.DB.prepare("SELECT thread_id FROM notes WHERE id = ?")
    .bind(noteId)
    .first<{ thread_id: string | null }>();
  await env.DB.prepare("UPDATE notes SET thread_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(threadId, noteId)
    .run();
  await env.DB.prepare(
    "UPDATE threads SET note_count = (SELECT COUNT(*) FROM notes WHERE thread_id = ?), updated_at = datetime('now') WHERE id = ?"
  )
    .bind(threadId, threadId)
    .run();
  // a note moved out of another thread (e.g. a graph-mate grab during
  // incremental clustering) leaves it with a stale count or a lone note
  if (prev?.thread_id && prev.thread_id !== threadId) {
    await reconcileThread(env, prev.thread_id).catch((err) =>
      console.error(`threads: reconcile after move failed for thread=${prev.thread_id}`, err)
    );
  }
}

async function deepseekPickNumber(env: Env, system: string, user: string, max: number): Promise<number | null> {
  const text = await chatComplete(env, {
    temperature: 0,
    max_tokens: 10,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  if (text === null) return null;
  const n = parseInt(text.trim(), 10);
  return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
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
 * Cluster a newly-saved idea note into a thread: embed it, compare with the
 * user's other idea notes (recent ones plus one representative per existing
 * thread, so years-old threads stay joinable), and join/create a thread on
 * high similarity. Falls back to a DeepSeek title-match when Workers AI is
 * unavailable. `frugal` (cron backfill over large histories) skips the
 * DeepSeek-only fallbacks to bound cost.
 * Never throws. Returns the thread id the note was attached to, if any.
 */
export async function clusterNote(
  env: Env,
  note: NoteRow,
  opts?: { useGraph?: boolean; deferSummaries?: boolean; frugal?: boolean }
): Promise<string | null> {
  const summarize = opts?.deferSummaries
    ? async () => {}
    : (threadId: string, fallbackTitle?: string) => summarizeThread(env, threadId, fallbackTitle);
  try {
    if (note.category !== "idea" && note.category !== "collect") return null;
    // graph signal first: an idea sharing entities/relations with an existing
    // idea joins its thread regardless of embedding similarity. Collect notes
    // skip this path: with no similarity floor, entity overlap alone (e.g. a
    // shared place name in an unrelated article) would over-join them.
    if (note.category === "idea" && !note.is_sensitive && opts?.useGraph !== false) {
      const mate = await findGraphThreadMate(env, note);
      if (mate) {
        console.log(`threads: graph mate note=${note.id} mate=${mate.note_id} shared=${mate.shared}`);
        // still store the embedding so search/ask recall keeps working
        if (!(await loadStoredEmbedding(env, note.id))) {
          const v = await embed(env, embedInput(note));
          if (v) await saveEmbedding(env, note.id, v);
        }
        let threadId = mate.thread_id;
        if (!threadId) {
          const m = await env.DB.prepare("SELECT title, content FROM notes WHERE id = ?")
            .bind(mate.note_id)
            .first<{ title: string | null; content: string }>();
          threadId = await newThread(env, note.user_id, m?.title || note.title || note.content.slice(0, 20));
          await attachNoteToThread(env, mate.note_id, threadId);
        }
        await attachNoteToThread(env, note.id, threadId);
        await summarize(threadId, note.title || undefined);
        return threadId;
      }
    }
    // sensitive notes never enter the vector store (content is encrypted at rest)
    let vector = note.is_sensitive ? null : await loadStoredEmbedding(env, note.id);
    if (!note.is_sensitive && !vector) {
      vector = await embed(env, embedInput(note));
      if (vector) await saveEmbedding(env, note.id, vector);
    }
    if (vector) {
      type Candidate = { id: string; thread_id: string | null; category: string; title: string | null; content: string; url_title: string | null; url_summary: string | null; vector: string | null };
      // recent ideas/collects (any age cap removed) + one representative note
      // per existing thread, so historical threads stay joinable beyond the window
      const { results } = await env.DB.prepare(
        `SELECT n.id, n.thread_id, n.category, n.title, n.content, n.url_title, n.url_summary, e.vector FROM notes n
         LEFT JOIN note_embeddings e ON e.note_id = n.id
         WHERE n.user_id = ? AND n.category IN ${THREAD_CATEGORIES} AND n.deleted_at IS NULL AND n.id != ?
         ORDER BY n.created_at DESC LIMIT 200`
      )
        .bind(note.user_id, note.id)
        .all<Candidate>();
      const candidates: Candidate[] = [...(results ?? [])];
      try {
        const { results: reps } = await env.DB.prepare(
          `SELECT n.id, n.thread_id, n.category, n.title, n.content, n.url_title, n.url_summary, e.vector FROM notes n
           LEFT JOIN note_embeddings e ON e.note_id = n.id
           WHERE n.id IN (
             SELECT (SELECT nn.id FROM notes nn WHERE nn.thread_id = t.id AND nn.deleted_at IS NULL
                     ORDER BY nn.created_at DESC LIMIT 1)
             FROM threads t WHERE t.user_id = ? AND t.note_count > 0
           ) AND n.id != ?`
        )
          .bind(note.user_id, note.id)
          .all<Candidate>();
        const seen = new Set(candidates.map((r) => r.id));
        for (const r of reps ?? []) if (!seen.has(r.id)) candidates.push(r);
      } catch (err) {
        console.error("threads: thread representatives query failed", err);
      }
      let best: { id: string; thread_id: string | null; category: string; title: string | null; content: string; sim: number } | null =
        null;
      let backfilled = 0;
      for (const r of candidates) {
        let v: number[] | null = null;
        if (r.vector) {
          try {
            v = JSON.parse(r.vector) as number[];
          } catch {
            v = null;
          }
        } else if (backfilled < 20) {
          // lazily embed older notes that predate the embeddings table
          backfilled++;
          v = await embed(env, embedInput(r));
          if (v) await saveEmbedding(env, r.id, v);
        }
        if (!v) continue;
        const sim = cosineSim(vector, v);
        if (!best || sim > best.sim)
          best = { id: r.id, thread_id: r.thread_id, category: r.category, title: r.title, content: r.content, sim };
      }
      if (best) {
        const direct = best.sim >= SIM_JOIN;
        const confirmed =
          !direct &&
          best.sim >= SIM_CONFIRM_FLOOR &&
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
          await summarize(threadId, note.title || undefined);
          return threadId;
        }
      } else {
        console.log(`threads: cluster note=${note.id} no comparable idea notes`);
      }
      // frugal path stops here: embedding prescreen + at most one confirm call.
      // collect notes also stop: the LLM-only fallbacks have no similarity
      // floor, so one-off article collects would over-join (see eval script)
      if (opts?.frugal || note.category === "collect") return null;
      // borderline/no embedding match: still try DeepSeek against existing thread titles
      const picked = await pickThreadByDeepseek(env, note);
      if (picked) {
        await attachNoteToThread(env, note.id, picked);
        await summarize(picked, note.title || undefined);
        return picked;
      }
      return null;
    }
    if (opts?.frugal || note.category === "collect") return null;
    // no embedding available: DeepSeek-only fallback (existing threads, then cold-start pairing)
    console.log(`threads: no embedding for note=${note.id}, using deepseek fallback`);
    const picked = await pickThreadByDeepseek(env, note);
    if (picked) {
      await attachNoteToThread(env, note.id, picked);
      await summarize(picked, note.title || undefined);
      return picked;
    }
    // cold start: no thread matched (or none exist) — pair with a recent unthreaded idea
    const { results: loose } = await env.DB.prepare(
      `SELECT id, title, content FROM notes
       WHERE user_id = ? AND category = 'idea' AND deleted_at IS NULL AND thread_id IS NULL AND id != ?
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
      await summarize(threadId, m.title || undefined);
      console.log(`threads: cold-start created thread ${threadId} for notes ${mate}, ${note.id}`);
      return threadId;
    }
    return null;
  } catch (err) {
    // clustering must never break note ingestion, but always leave a trace
    console.error(`threads: clusterNote failed for note=${note.id}`, err);
    return null;
  }
}

export async function pickThreadByDeepseek(env: Env, note: NoteRow): Promise<string | null> {
  const { results: threads } = await env.DB.prepare(
    "SELECT id, title FROM threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 30"
  )
    .bind(note.user_id)
    .all<{ id: string; title: string }>();
  return deepseekPickThread(env, note.content, threads ?? []);
}

/** Resumable rebuild state, persisted as JSON in thread_jobs.state. */
export interface RebuildState {
  phase: "reset" | "cluster" | "second_pass" | "summarize" | "done";
  /** (created_at, id) cursor within the current phase's chronological scan. */
  cursorCreatedAt: string;
  cursorId: string;
  total: number;
  processed: number;
  secondPassed: number;
  /** summarize-phase progress: threads summarized so far / to summarize. */
  summarized?: number;
  summarizeTotal?: number;
  threads: number;
  useGraph: boolean;
}

export function newRebuildState(opts?: { useGraph?: boolean }): RebuildState {
  return {
    phase: "reset",
    cursorCreatedAt: "",
    cursorId: "",
    total: 0,
    processed: 0,
    secondPassed: 0,
    summarized: 0,
    summarizeTotal: 0,
    threads: 0,
    useGraph: opts?.useGraph !== false,
  };
}

const REBUILD_BATCH = 10;
/** Cap on the LLM-heavy second pass (leftover-to-thread matching). */
const REBUILD_SECOND_PASS_MAX = 200;

/**
 * Run one bounded slice of a full-history rebuild: detach all idea notes,
 * re-cluster them oldest-first in batches, second-pass leftovers, then
 * summarize surviving threads. Mutates and returns `state`; call again with
 * the returned state (persisted between invocations) until phase === "done".
 * Stops early once `deadline` (ms epoch) passes.
 */
export async function rebuildStep(env: Env, userId: string, state: RebuildState, deadline: number): Promise<RebuildState> {
  if (state.phase === "reset") {
    const cnt = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM notes WHERE user_id = ? AND category IN ${THREAD_CATEGORIES} AND deleted_at IS NULL`
    )
      .bind(userId)
      .first<{ c: number }>();
    state.total = cnt?.c ?? 0;
    await env.DB.prepare(`UPDATE notes SET thread_id = NULL WHERE user_id = ? AND category IN ${THREAD_CATEGORIES}`)
      .bind(userId)
      .run();
    await env.DB.prepare(
      "DELETE FROM threads WHERE user_id = ? AND id NOT IN (SELECT DISTINCT thread_id FROM notes WHERE thread_id IS NOT NULL)"
    )
      .bind(userId)
      .run();
    state.phase = "cluster";
    state.cursorCreatedAt = "";
    state.cursorId = "";
    return state;
  }
  if (state.phase === "cluster") {
    while (Date.now() < deadline) {
      const { results } = await env.DB.prepare(
        `SELECT * FROM notes WHERE user_id = ?1 AND category IN ${THREAD_CATEGORIES} AND deleted_at IS NULL
           AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))
         ORDER BY created_at ASC, id ASC LIMIT ${REBUILD_BATCH}`
      )
        .bind(userId, state.cursorCreatedAt, state.cursorId)
        .all<NoteRow>();
      const rows = results ?? [];
      if (rows.length === 0) {
        // drop threads emptied by mate-moves during clustering and dissolve
        // 1-note leftovers, freeing their notes for the second pass
        await reconcileThreads(env, userId);
        state.phase = "second_pass";
        state.cursorCreatedAt = "";
        state.cursorId = "";
        return state;
      }
      for (const n of rows) {
        if (n.thread_id === null) {
          await clusterNote(env, n, { useGraph: state.useGraph, deferSummaries: true });
        }
        state.processed++;
        state.cursorCreatedAt = n.created_at;
        state.cursorId = n.id;
        if (Date.now() >= deadline) return state;
      }
    }
    return state;
  }
  if (state.phase === "second_pass") {
    // ideas that stayed unthreaded on the chronological pass (their topic-mates
    // came later) get one more match against the full thread set
    while (Date.now() < deadline && state.secondPassed < REBUILD_SECOND_PASS_MAX) {
      const { results } = await env.DB.prepare(
        `SELECT * FROM notes WHERE user_id = ?1 AND category = 'idea' AND deleted_at IS NULL AND thread_id IS NULL
           AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))
         ORDER BY created_at ASC, id ASC LIMIT ${REBUILD_BATCH}`
      )
        .bind(userId, state.cursorCreatedAt, state.cursorId)
        .all<NoteRow>();
      const rows = results ?? [];
      if (rows.length === 0) break;
      for (const n of rows) {
        try {
          const picked = await pickThreadByDeepseek(env, n);
          if (picked) await attachNoteToThread(env, n.id, picked);
        } catch (err) {
          console.error(`threads: rebuild second pass failed for note=${n.id}`, err);
        }
        state.secondPassed++;
        state.cursorCreatedAt = n.created_at;
        state.cursorId = n.id;
        if (Date.now() >= deadline || state.secondPassed >= REBUILD_SECOND_PASS_MAX) break;
      }
    }
    if (Date.now() < deadline) {
      state.phase = "summarize";
      state.cursorCreatedAt = "";
      state.cursorId = "";
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM threads WHERE user_id = ? AND note_count > 0")
        .bind(userId)
        .first<{ c: number }>();
      state.summarizeTotal = cnt?.c ?? 0;
      state.summarized = 0;
    }
    return state;
  }
  if (state.phase === "summarize") {
    // summaries were deferred during clustering: summarize each surviving thread once
    while (Date.now() < deadline) {
      const { results } = await env.DB.prepare(
        `SELECT id FROM threads WHERE user_id = ? AND note_count > 0 AND id > ? ORDER BY id ASC LIMIT ${REBUILD_BATCH}`
      )
        .bind(userId, state.cursorId)
        .all<{ id: string }>();
      const rows = results ?? [];
      if (rows.length === 0) {
        const cnt = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM threads WHERE user_id = ? AND note_count > 0"
        )
          .bind(userId)
          .first<{ c: number }>();
        state.threads = cnt?.c ?? 0;
        state.phase = "done";
        console.log(`threads: rebuild for user=${userId} ideas=${state.total} threads=${state.threads}`);
        return state;
      }
      for (const t of rows) {
        await summarizeThread(env, t.id);
        state.summarized = (state.summarized ?? 0) + 1;
        state.cursorId = t.id;
        if (Date.now() >= deadline) return state;
      }
    }
    return state;
  }
  return state;
}

/**
 * Full re-cluster of ALL of a user's idea notes, synchronously to completion
 * (tests / small accounts). Production traffic goes through thread_jobs
 * slices instead — see thread-jobs.ts.
 */
export async function rebuildThreads(
  env: Env,
  userId: string,
  opts?: { useGraph?: boolean }
): Promise<{ ideas: number; threads: number }> {
  let state = newRebuildState(opts);
  while (state.phase !== "done") {
    state = await rebuildStep(env, userId, state, Number.MAX_SAFE_INTEGER);
  }
  return { ideas: state.total, threads: state.threads };
}

/**
 * Reconcile a single thread against its actual notes: delete it when empty,
 * dissolve it when only one note remains (detaching the note), or refresh a
 * stale note_count. Pass knownCount when the caller already read note_count
 * to skip a redundant UPDATE.
 */
export async function reconcileThread(
  env: Env,
  threadId: string,
  knownCount?: number
): Promise<"deleted" | "dissolved" | "recounted" | "ok"> {
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM notes WHERE thread_id = ? AND deleted_at IS NULL")
    .bind(threadId)
    .first<{ c: number }>();
  const c = cnt?.c ?? 0;
  if (c === 0) {
    await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(threadId).run();
    return "deleted";
  }
  if (c === 1) {
    await env.DB.prepare(
      "UPDATE notes SET thread_id = NULL, updated_at = datetime('now') WHERE thread_id = ?"
    )
      .bind(threadId)
      .run();
    await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(threadId).run();
    return "dissolved";
  }
  if (c !== knownCount) {
    await env.DB.prepare(
      "UPDATE threads SET note_count = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(c, threadId)
      .run();
    return "recounted";
  }
  return "ok";
}

/**
 * Recount every thread from its notes and clean up degenerate ones: a thread
 * with 0 notes is deleted, a thread left with a single note is dissolved (the
 * note is detached — a thread only makes sense with ≥2 fragments). Scoped to
 * one user when userId is given; otherwise sweeps all threads.
 */
export async function reconcileThreads(
  env: Env,
  userId?: string
): Promise<{ deleted: number; dissolved: number }> {
  const stmt = userId
    ? env.DB.prepare("SELECT id, note_count FROM threads WHERE user_id = ?").bind(userId)
    : env.DB.prepare("SELECT id, note_count FROM threads");
  const { results } = await stmt.all<{ id: string; note_count: number }>();
  let deleted = 0;
  let dissolved = 0;
  for (const t of results ?? []) {
    // isolate per-thread failures so one bad row never aborts the whole sweep
    try {
      const outcome = await reconcileThread(env, t.id, t.note_count);
      if (outcome === "deleted") deleted++;
      else if (outcome === "dissolved") dissolved++;
    } catch (err) {
      console.error(`threads: reconcile failed for thread=${t.id}`, err);
    }
  }
  if (deleted || dissolved)
    console.log(
      `threads: reconcile${userId ? ` user=${userId}` : ""} deleted=${deleted} dissolved=${dissolved}`
    );
  return { deleted, dissolved };
}

/**
 * Merge duplicate same-topic threads (R109 P2-1): two notes on the same topic
 * saved concurrently can each spawn a thread (both clusterNote calls read "no
 * thread yet" before either writes). Rather than serializing ingestion,
 * compare each thread's representative (newest non-sensitive note) embedding
 * and fold pairs at/above SIM_JOIN into the older thread. `aroundThreadId`
 * scopes the scan to one freshly-touched thread (ingest pipeline); without it
 * every thread of the user is scanned (daily refresh). Never throws.
 */
export async function mergeDuplicateThreads(env: Env, userId: string, aroundThreadId?: string): Promise<number> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, created_at FROM threads WHERE user_id = ? AND note_count > 0 ORDER BY created_at ASC LIMIT 100"
    )
      .bind(userId)
      .all<{ id: string; created_at: string }>();
    const threads = results ?? [];
    if (threads.length < 2) return 0;
    const reps = new Map<string, number[] | null>();
    const repVector = async (threadId: string): Promise<number[] | null> => {
      if (!reps.has(threadId)) {
        const row = await env.DB.prepare(
          `SELECT e.vector FROM notes n JOIN note_embeddings e ON e.note_id = n.id
            WHERE n.thread_id = ? AND n.deleted_at IS NULL AND n.is_sensitive = 0
            ORDER BY n.created_at DESC LIMIT 1`
        )
          .bind(threadId)
          .first<{ vector: string }>();
        let v: number[] | null = null;
        if (row?.vector) {
          try {
            const p = JSON.parse(row.vector) as number[];
            v = Array.isArray(p) && p.length > 0 ? p : null;
          } catch {
            v = null;
          }
        }
        reps.set(threadId, v);
      }
      return reps.get(threadId)!;
    };
    let merged = 0;
    const targets = aroundThreadId ? threads.filter((t) => t.id === aroundThreadId) : threads;
    for (const t of targets) {
      const tv = await repVector(t.id);
      if (!tv) continue;
      for (const o of threads) {
        if (o.id === t.id) continue;
        const ov = await repVector(o.id);
        if (!ov) continue;
        if (cosineSim(tv, ov) < SIM_JOIN) continue;
        // fold the newer thread into the older one
        const [keep, drop] = t.created_at <= o.created_at ? [t, o] : [o, t];
        await env.DB.prepare("UPDATE notes SET thread_id = ?, updated_at = datetime('now') WHERE thread_id = ?")
          .bind(keep.id, drop.id)
          .run();
        await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(drop.id).run();
        await reconcileThread(env, keep.id);
        reps.delete(keep.id);
        reps.delete(drop.id);
        merged++;
        console.log(`threads: merged duplicate thread ${drop.id} into ${keep.id} (user=${userId})`);
        if (aroundThreadId) return merged; // scoped thread may have been folded away
        break;
      }
    }
    return merged;
  } catch (err) {
    console.error(`threads: mergeDuplicateThreads failed for user=${userId}`, err);
    return 0;
  }
}

/** Daily cron: refresh title/summary/note_count of every thread from its notes. */
export async function refreshThreads(env: Env): Promise<void> {
  // drop orphaned (0-note) threads and dissolve 1-note leftovers first
  await reconcileThreads(env).catch((err) => console.error("threads: reconcile failed", err));
  // fold duplicate same-topic threads left behind by concurrent clustering
  const { results: users } = await env.DB.prepare("SELECT DISTINCT user_id FROM threads").all<{ user_id: string }>();
  for (const u of users ?? []) await mergeDuplicateThreads(env, u.user_id);
  const { results: threads } = await env.DB.prepare(
    "SELECT id, user_id, title FROM threads"
  ).all<{ id: string; user_id: string; title: string }>();
  for (const t of threads ?? []) {
    try {
      const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM notes WHERE thread_id = ? AND deleted_at IS NULL")
        .bind(t.id)
        .first<{ c: number }>();
      await env.DB.prepare(
        "UPDATE threads SET note_count = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(cnt?.c ?? 0, t.id)
        .run();
      if ((cnt?.c ?? 0) > 0) await summarizeThread(env, t.id, t.title);
    } catch {
      /* per-thread failures shouldn't stop the sweep */
    }
  }
}
