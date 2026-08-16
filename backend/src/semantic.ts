import type { Env, NoteRow } from "./types";
import { withTimeout } from "./ai";
import { cosineSim } from "./threads";

const EMBED_MODEL = "@cf/baai/bge-m3";

/** Cosine similarity above which a note counts as a semantic match for search/ask recall. */
export const SEMANTIC_MIN_SCORE = 0.45;

// Small corpora (R151 P2-3): with only a handful of notes, everything is "the
// closest match" and 0.45 lets unrelated notes surface as 语义匹配 (e.g. a
// coffee note for 「跑步」). Below this corpus size a stricter floor applies;
// larger corpora keep the recall-friendly threshold since real matches
// naturally outrank noise there.
export const SEMANTIC_SMALL_CORPUS_MAX = 20;
export const SEMANTIC_SMALL_CORPUS_MIN_SCORE = 0.6;

/** Effective semantic threshold for a corpus of `corpusSize` vectors. */
export function semanticMinScoreFor(corpusSize: number, minScore = SEMANTIC_MIN_SCORE): number {
  return corpusSize < SEMANTIC_SMALL_CORPUS_MAX ? Math.max(minScore, SEMANTIC_SMALL_CORPUS_MIN_SCORE) : minScore;
}

// Workers AI cold starts can hang tens of seconds; interactive search/ask
// must degrade to keyword recall instead of blocking on the embedding
const EMBED_TIMEOUT_MS = 8_000;
// batch embedding runs in background pipelines (retriage, migration), where a
// longer window beats losing the whole batch to a cold start
const EMBED_BATCH_TIMEOUT_MS = 30_000;

export async function embedText(env: Env, text: string, timeoutMs = EMBED_TIMEOUT_MS): Promise<number[] | null> {
  if (!env.AI) return null;
  try {
    const res = (await withTimeout(
      env.AI.run(EMBED_MODEL, { text: [text.slice(0, 1000)] }) as Promise<{ data?: number[][] }>,
      timeoutMs,
      "embed"
    )) as { data?: number[][] };
    const v = res?.data?.[0];
    return Array.isArray(v) && v.length > 0 ? v : null;
  } catch (err) {
    console.error("semantic: embed failed", err);
    return null;
  }
}

/** The text a note is embedded from: title + content + link metadata. */
export function noteEmbedText(n: Pick<NoteRow, "title" | "content" | "url_title" | "url_summary">): string {
  return [n.title, n.content, n.url_title, n.url_summary].filter(Boolean).join("\n");
}

/**
 * Embed a note and store its vector, or remove the vector when the note is
 * sensitive (encrypted content must never enter the vector store). If a
 * Vectorize binding is configured the vector is mirrored there with a
 * user_id metadata filter; D1 remains the source of truth. Never throws.
 */
export async function upsertNoteEmbedding(env: Env, note: NoteRow): Promise<void> {
  try {
    if (note.is_sensitive) {
      await deleteNoteEmbedding(env, note.id);
      return;
    }
    // background pipeline: allow a longer window than interactive queries
    const vector = await embedText(env, noteEmbedText(note), 30_000);
    if (!vector) return;
    await env.DB.prepare("INSERT OR REPLACE INTO note_embeddings (note_id, vector) VALUES (?, ?)")
      .bind(note.id, JSON.stringify(vector))
      .run();
    if (env.VECTORIZE) {
      await env.VECTORIZE.upsert([
        { id: note.id, values: vector, metadata: { user_id: note.user_id } },
      ]);
    }
  } catch (err) {
    console.error(`semantic: upsert embedding failed for note=${note.id}`, err);
  }
}

/** Remove a note's vector from D1 (and Vectorize when configured). Never throws. */
export async function deleteNoteEmbedding(env: Env, noteId: string): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM note_embeddings WHERE note_id = ?").bind(noteId).run();
    if (env.VECTORIZE) await env.VECTORIZE.deleteByIds([noteId]);
  } catch (err) {
    console.error(`semantic: delete embedding failed for note=${noteId}`, err);
  }
}

/** Remove many notes' vectors from D1 (and Vectorize when configured) in one go. Never throws. */
export async function deleteNoteEmbeddings(env: Env, noteIds: string[]): Promise<void> {
  if (noteIds.length === 0) return;
  try {
    const ph = noteIds.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM note_embeddings WHERE note_id IN (${ph})`).bind(...noteIds).run();
    if (env.VECTORIZE) await env.VECTORIZE.deleteByIds(noteIds);
  } catch (err) {
    console.error(`semantic: batch delete embeddings failed (${noteIds.length} notes)`, err);
  }
}

export type SemanticHit = { note_id: string; score: number };

/**
 * Semantic recall for a user's notes: embed the query, then rank against
 * stored vectors. Uses Vectorize (topK, user_id metadata filter) when the
 * binding exists, otherwise brute-force cosine over the user's vectors in D1
 * (small per-user data volumes make this fine). Returns [] on any failure so
 * callers degrade to pure keyword recall.
 */
export async function semanticRecall(
  env: Env,
  userId: string,
  query: string,
  topK = 10,
  minScore = SEMANTIC_MIN_SCORE
): Promise<SemanticHit[]> {
  try {
    const qv = await embedText(env, query);
    if (!qv) return [];
    if (env.VECTORIZE) {
      const cnt = await env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM note_embeddings e JOIN notes n ON n.id = e.note_id WHERE n.user_id = ? AND n.is_sensitive = 0"
      )
        .bind(userId)
        .first<{ cnt: number }>();
      const effMin = semanticMinScoreFor(cnt?.cnt ?? 0, minScore);
      const res = await env.VECTORIZE.query(qv, {
        topK,
        filter: { user_id: userId },
        returnValues: false,
        returnMetadata: "none",
      });
      return (res.matches ?? [])
        .filter((m) => m.score >= effMin)
        .map((m) => ({ note_id: m.id, score: m.score }));
    }
    // page through ALL of the user's vectors (batched to stay under D1's
    // per-query response size): a fixed newest-N window silently blinds
    // semantic recall to older notes once the account outgrows it
    const scored: SemanticHit[] = [];
    let corpusSize = 0;
    const BATCH = 400;
    const MAX_VECTORS = 4000;
    for (let offset = 0; offset < MAX_VECTORS; offset += BATCH) {
      const { results } = await env.DB.prepare(
        `SELECT e.note_id, e.vector FROM note_embeddings e
         JOIN notes n ON n.id = e.note_id
         WHERE n.user_id = ? AND n.is_sensitive = 0
         ORDER BY n.created_at DESC LIMIT ? OFFSET ?`
      )
        .bind(userId, BATCH, offset)
        .all<{ note_id: string; vector: string }>();
      const rows = results ?? [];
      corpusSize += rows.length;
      for (const r of rows) {
        let v: number[];
        try {
          v = JSON.parse(r.vector) as number[];
        } catch {
          continue;
        }
        const score = cosineSim(qv, v);
        if (score >= minScore) scored.push({ note_id: r.note_id, score });
      }
      if (rows.length < BATCH) break;
    }
    const effMin = semanticMinScoreFor(corpusSize, minScore);
    const hits = scored.filter((h) => h.score >= effMin);
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  } catch (err) {
    console.error("semantic: recall failed", err);
    return [];
  }
}

/** Wall-clock budget for the cron embedding backfill (batched, so this drains thousands per run). */
export const EMBED_BACKFILL_BUDGET_MS = 60_000;

/** Batch-embed several texts in one Workers AI call; per-text null on failure. */
export async function embedTexts(env: Env, texts: string[]): Promise<(number[] | null)[]> {
  if (!env.AI || texts.length === 0) return texts.map(() => null);
  try {
    const res = (await withTimeout(
      env.AI.run(EMBED_MODEL, { text: texts.map((t) => t.slice(0, 1000)) }) as Promise<{ data?: number[][] }>,
      EMBED_BATCH_TIMEOUT_MS,
      "batch embed"
    )) as { data?: number[][] };
    return texts.map((_, i) => {
      const v = res?.data?.[i];
      return Array.isArray(v) && v.length > 0 ? v : null;
    });
  } catch (err) {
    console.error("semantic: batch embed failed", err);
    return texts.map(() => null);
  }
}

/**
 * Cron backfill: embed non-sensitive notes that don't have a vector yet,
 * oldest first. Each round batch-embeds `limit` notes in a single Workers AI
 * call and bulk-writes the vectors; with a time budget it keeps draining
 * rounds until the backlog is empty or the budget is spent, so bulk imports
 * become searchable within minutes instead of days.
 */
export async function backfillEmbeddings(env: Env, limit = 20, timeBudgetMs = 0): Promise<number> {
  const started = Date.now();
  let done = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT * FROM notes n
       WHERE n.is_sensitive = 0 AND n.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM note_embeddings e WHERE e.note_id = n.id)
       ORDER BY n.created_at ASC LIMIT ?`
    )
      .bind(limit)
      .all<NoteRow>();
    const rows = results ?? [];
    if (rows.length === 0) break;
    const vectors = await embedTexts(env, rows.map((n) => noteEmbedText(n)));
    const embedded: { note: NoteRow; vector: number[] }[] = [];
    vectors.forEach((v, i) => {
      if (v) embedded.push({ note: rows[i], vector: v });
    });
    if (embedded.length === 0) break; // AI unavailable: stop instead of spinning
    const insert = env.DB.prepare("INSERT OR REPLACE INTO note_embeddings (note_id, vector) VALUES (?, ?)");
    for (const { note, vector } of embedded) {
      await insert.bind(note.id, JSON.stringify(vector)).run();
    }
    if (env.VECTORIZE) {
      await env.VECTORIZE.upsert(
        embedded.map(({ note, vector }) => ({ id: note.id, values: vector, metadata: { user_id: note.user_id } }))
      ).catch((err) => console.error("semantic: vectorize bulk upsert failed", err));
    }
    done += embedded.length;
    if (rows.length < limit || embedded.length < rows.length) break;
    if (Date.now() - started >= timeBudgetMs) break;
  }
  if (done > 0) console.log(`semantic: backfilled ${done} embeddings`);
  return done;
}
