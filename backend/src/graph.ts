import type { Env, NoteRow } from "./types";
import { chatComplete } from "./ai";
import { embedText, semanticRecall, cosineSim } from "./semantic";

/** Cosine similarity between entity-name embeddings above which two names are the same entity. */
const ENTITY_MERGE_SIM = 0.92;
/** looser than merge: near-duplicate topic nodes count as bridges during expansion */
const ENTITY_EXPAND_SIM = 0.8;
/** Entity-entity edge confidence considered a strong relation for clustering. */
export const STRONG_EDGE_CONF = 0.6;

export const ENTITY_TYPES = ["person", "project", "concept", "product", "org", "place", "other"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATIONS = ["supports", "premise_of", "belongs_to", "todo_of", "relates_to"] as const;
export type Relation = (typeof RELATIONS)[number];

export const RELATION_LABEL: Record<string, string> = {
  supports: "支撑",
  premise_of: "前提",
  belongs_to: "属于",
  todo_of: "待办于",
  relates_to: "相关",
  mentions: "提及",
};

export interface EntityRow {
  id: string;
  user_id: string;
  name: string;
  type: string;
  aliases: string;
  note_count: number;
  vector: string | null;
}

interface ExtractedEntity {
  name: string;
  type: EntityType;
  aliases?: string[];
}

interface ExtractedRelation {
  src: string;
  dst: string;
  relation: Relation;
  confidence?: number;
}

const EXTRACT_SYSTEM = `你是知识图谱抽取器。从一条个人笔记中抽取具体实体与实体间关系，输出严格 JSON：
{"entities":[{"name":"规范名","type":"person|project|concept|product|org|place|other","aliases":["别名"]}],"relations":[{"src":"实体名","dst":"实体名","relation":"supports|premise_of|belongs_to|todo_of|relates_to","confidence":0.8}]}
规则：
- 实体必须是笔记中出现或明确指代的具体事物（人名/项目名/产品名/组织/地点/书名/具体概念），最多 6 个
- 出现的人名、产品名、书名必须抽出，不要漏；书名归 concept，人物归 person，软件/App 归 product
- 优先用 supports/premise_of/belongs_to/todo_of 表达关系，仅在都不合适时才用 relates_to
- 禁止抽泛化词（想法、问题、东西、事情、内容、笔记等），也不要抽时间词（周五、下周三、十月等）
- 忽略方括号标记与前缀（如 [QA-R20]、[测试] 之类的标记），不要作为实体
- 关系最多 4 条，src/dst 必须来自 entities 里的 name；supports=支撑依据，premise_of=前提，belongs_to=属于，todo_of=待办于，relates_to=其他相关
- confidence 是 0~1 的自评置信度
- 没有可抽的就输出 {"entities":[],"relations":[]}。只输出 JSON。`;

export function parseExtraction(text: string): { entities: ExtractedEntity[]; relations: ExtractedRelation[] } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { entities?: unknown; relations?: unknown };
    const entities: ExtractedEntity[] = [];
    if (Array.isArray(obj.entities)) {
      for (const e of obj.entities.slice(0, 6)) {
        if (!e || typeof e !== "object") continue;
        const { name, type, aliases } = e as { name?: unknown; type?: unknown; aliases?: unknown };
        if (typeof name !== "string" || !name.trim() || name.trim().length > 60) continue;
        const t = typeof type === "string" && (ENTITY_TYPES as readonly string[]).includes(type) ? (type as EntityType) : "other";
        entities.push({
          name: name.trim(),
          type: t,
          aliases: Array.isArray(aliases)
            ? aliases.filter((a): a is string => typeof a === "string" && !!a.trim()).map((a) => a.trim()).slice(0, 4)
            : [],
        });
      }
    }
    const relations: ExtractedRelation[] = [];
    if (Array.isArray(obj.relations)) {
      for (const r of obj.relations.slice(0, 4)) {
        if (!r || typeof r !== "object") continue;
        const { src, dst, relation, confidence } = r as { src?: unknown; dst?: unknown; relation?: unknown; confidence?: unknown };
        if (typeof src !== "string" || typeof dst !== "string" || src === dst) continue;
        if (typeof relation !== "string" || !(RELATIONS as readonly string[]).includes(relation)) continue;
        const conf = typeof confidence === "number" && confidence >= 0 && confidence <= 1 ? confidence : 0.5;
        relations.push({ src: src.trim(), dst: dst.trim(), relation: relation as Relation, confidence: conf });
      }
    }
    return { entities, relations };
  } catch {
    return null;
  }
}

/**
 * Resolve an extracted entity to an existing row (exact name / alias match,
 * then bge-m3 name-embedding similarity within the same type) or create it.
 * New aliases discovered during a merge are accumulated on the existing row.
 */
async function resolveEntity(env: Env, userId: string, ent: ExtractedEntity): Promise<string> {
  const names = [ent.name, ...(ent.aliases ?? [])];
  const { results } = await env.DB.prepare("SELECT * FROM entities WHERE user_id = ?")
    .bind(userId)
    .all<EntityRow>();
  const rows = results ?? [];
  const lc = (s: string) => s.trim().toLowerCase();
  const nameSet = new Set(names.map(lc));
  let match: EntityRow | null = null;
  for (const r of rows) {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(r.aliases || "[]") as string[];
    } catch {
      aliases = [];
    }
    const known = [r.name, ...aliases].map(lc);
    if (known.some((k) => nameSet.has(k))) {
      match = r;
      break;
    }
  }
  let vector: number[] | null = null;
  if (!match) {
    // embedding-assisted merge within the same type
    vector = await embedText(env, ent.name);
    if (vector) {
      let best: { row: EntityRow; sim: number } | null = null;
      for (const r of rows) {
        if (r.type !== ent.type || !r.vector) continue;
        try {
          const sim = cosineSim(vector, JSON.parse(r.vector) as number[]);
          if (!best || sim > best.sim) best = { row: r, sim };
        } catch {
          /* skip bad vector */
        }
      }
      if (best && best.sim >= ENTITY_MERGE_SIM) match = best.row;
    }
  }
  if (match) {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(match.aliases || "[]") as string[];
    } catch {
      aliases = [];
    }
    const known = new Set([match.name, ...aliases].map(lc));
    const added = names.filter((n) => !known.has(lc(n)));
    if (added.length > 0) {
      await env.DB.prepare("UPDATE entities SET aliases = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(JSON.stringify([...aliases, ...added].slice(0, 12)), match.id)
        .run();
    }
    return match.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO entities (id, user_id, name, type, aliases, note_count, vector) VALUES (?, ?, ?, ?, ?, 0, ?)"
  )
    .bind(id, userId, ent.name, ent.type, JSON.stringify(ent.aliases ?? []), vector ? JSON.stringify(vector) : null)
    .run();
  return id;
}

async function addEdge(
  env: Env,
  userId: string,
  src: { type: string; id: string },
  dst: { type: string; id: string },
  relation: string,
  confidence: number,
  noteId: string | null
): Promise<void> {
  const dup = await env.DB.prepare(
    "SELECT id FROM edges WHERE user_id = ? AND src_type = ? AND src_id = ? AND dst_type = ? AND dst_id = ? AND relation = ?"
  )
    .bind(userId, src.type, src.id, dst.type, dst.id, relation)
    .first<{ id: string }>();
  if (dup) return;
  await env.DB.prepare(
    "INSERT INTO edges (id, user_id, src_type, src_id, dst_type, dst_id, relation, confidence, note_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(crypto.randomUUID(), userId, src.type, src.id, dst.type, dst.id, relation, confidence, noteId)
    .run();
}

async function refreshEntityNoteCount(env: Env, entityId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE entities SET note_count = (
       SELECT COUNT(DISTINCT src_id) FROM edges WHERE dst_type = 'entity' AND dst_id = ? AND src_type = 'note' AND relation = 'mentions'
     ), updated_at = datetime('now') WHERE id = ?`
  )
    .bind(entityId, entityId)
    .run();
}

/** Record graph extraction status in notes.meta (merges with existing meta). Never throws. */
async function markGraphExtracted(env: Env, noteId: string): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT meta FROM notes WHERE id = ?").bind(noteId).first<{ meta: string | null }>();
    let meta: Record<string, unknown> = {};
    try {
      meta = row?.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    meta.graph_extracted_at = new Date().toISOString();
    await env.DB.prepare("UPDATE notes SET meta = ? WHERE id = ?").bind(JSON.stringify(meta), noteId).run();
  } catch (err) {
    console.error(`graph: mark extracted failed for note=${noteId}`, err);
  }
}

/**
 * Extract entities/relations from a note into the graph. Sensitive notes never
 * enter the graph (same principle as the vector store). Never throws.
 */
export async function extractGraph(env: Env, note: NoteRow): Promise<void> {
  try {
    if (note.is_sensitive) {
      await deleteNoteGraph(env, note.id);
      return;
    }
    const text = [note.title, note.content.slice(0, 1500), note.url_title, note.url_summary]
      .filter(Boolean)
      .join("\n");
    if (!text.trim()) return;
    console.log(`graph: extracting note=${note.id}`);
    const out = await chatComplete(env, {
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: text },
      ],
    });
    if (!out) {
      console.log(`graph: chatComplete returned null for note=${note.id}`);
      return; // AI unavailable: leave unmarked so the cron retries
    }
    const parsed = parseExtraction(out);
    if (!parsed) {
      console.log(`graph: unparseable extraction for note=${note.id}: ${out.slice(0, 150)}`);
      await markGraphExtracted(env, note.id);
      return;
    }
    // re-extraction (edited note): drop old evidence first
    await deleteNoteGraph(env, note.id);
    const idByName = new Map<string, string>();
    for (const ent of parsed.entities) {
      const id = await resolveEntity(env, note.user_id, ent);
      idByName.set(ent.name.toLowerCase(), id);
      await addEdge(env, note.user_id, { type: "note", id: note.id }, { type: "entity", id }, "mentions", 1, note.id);
      await refreshEntityNoteCount(env, id);
    }
    for (const rel of parsed.relations) {
      const src = idByName.get(rel.src.toLowerCase());
      const dst = idByName.get(rel.dst.toLowerCase());
      if (!src || !dst || src === dst) continue;
      await addEdge(env, note.user_id, { type: "entity", id: src }, { type: "entity", id: dst }, rel.relation, rel.confidence ?? 0.5, note.id);
    }
    await markGraphExtracted(env, note.id);
    console.log(`graph: extracted note=${note.id} entities=${parsed.entities.length} relations=${parsed.relations.length}`);
  } catch (err) {
    console.error(`graph: extract failed for note=${note.id}`, err);
  }
}

/**
 * Remove a note's evidence from the graph: its mention edges, entity-entity
 * edges extracted from it, and any entities left with no mentions. Never throws.
 */
export async function deleteNoteGraph(env: Env, noteId: string): Promise<void> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT dst_id AS id FROM edges WHERE note_id = ? AND dst_type = 'entity'"
    )
      .bind(noteId)
      .all<{ id: string }>();
    await env.DB.prepare("DELETE FROM edges WHERE note_id = ?").bind(noteId).run();
    for (const e of results ?? []) {
      await refreshEntityNoteCount(env, e.id);
    }
    await dropOrphanEntities(env, (results ?? []).map((e) => e.id));
  } catch (err) {
    console.error(`graph: delete failed for note=${noteId}`, err);
  }
}

/**
 * Drop entities left with no mentions, and their remaining edges — but only
 * among the entities this deletion actually touched. A global
 * `DELETE … WHERE note_count = 0` (pre-R162) raced concurrent extraction:
 * a freshly-inserted entity of ANY user still sits at note_count = 0 until
 * its mention edge lands, so an unrelated delete could reap it and leave the
 * incoming edges dangling (audit-r161 P2-2). Scoping to the touched ids also
 * removes the cross-user blast radius; the delete stays conditional on
 * note_count = 0 so an entity re-mentioned in between survives.
 */
async function dropOrphanEntities(env: Env, entityIds: string[]): Promise<void> {
  if (entityIds.length === 0) return;
  const ph = entityIds.map(() => "?").join(",");
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM edges WHERE (src_type = 'entity' AND src_id IN (SELECT id FROM entities WHERE id IN (${ph}) AND note_count = 0)) OR (dst_type = 'entity' AND dst_id IN (SELECT id FROM entities WHERE id IN (${ph}) AND note_count = 0))`
    ).bind(...entityIds, ...entityIds),
    env.DB.prepare(`DELETE FROM entities WHERE id IN (${ph}) AND note_count = 0`).bind(...entityIds),
  ]);
}

/**
 * Batch variant of deleteNoteGraph: removes many notes' evidence with a single
 * pass of chunk-wide statements plus one entity-count refresh per touched
 * entity. Never throws.
 */
export async function deleteNotesGraph(env: Env, noteIds: string[]): Promise<void> {
  if (noteIds.length === 0) return;
  try {
    const ph = noteIds.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT dst_id AS id FROM edges WHERE note_id IN (${ph}) AND dst_type = 'entity'`
    )
      .bind(...noteIds)
      .all<{ id: string }>();
    await env.DB.prepare(`DELETE FROM edges WHERE note_id IN (${ph})`).bind(...noteIds).run();
    for (const e of results ?? []) {
      await refreshEntityNoteCount(env, e.id);
    }
    await dropOrphanEntities(env, (results ?? []).map((e) => e.id));
  } catch (err) {
    console.error(`graph: batch delete failed (${noteIds.length} notes)`, err);
  }
}

/** Entity ids mentioned by a note. */
async function noteEntityIds(env: Env, noteId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT dst_id FROM edges WHERE src_type = 'note' AND src_id = ? AND relation = 'mentions'"
  )
    .bind(noteId)
    .all<{ dst_id: string }>();
  return (results ?? []).map((r) => r.dst_id);
}

/**
 * Graph signal for thread clustering: find the best idea-note "mate" from the
 * last 90 days that shares >=2 entities with this note, or shares 1 entity that
 * participates in a strong entity-entity relation. Returns null when the graph
 * has no signal (caller falls back to embedding similarity).
 */
export async function findGraphThreadMate(
  env: Env,
  note: NoteRow
): Promise<{ note_id: string; thread_id: string | null; shared: number } | null> {
  try {
    const ents = await noteEntityIds(env, note.id);
    console.log(`graph: mate lookup note=${note.id} ents=${ents.length}`);
    if (ents.length === 0) return null;
    const ph = ents.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT e.src_id AS note_id, COUNT(DISTINCT e.dst_id) AS shared, n.thread_id
       FROM edges e JOIN notes n ON n.id = e.src_id
       WHERE e.user_id = ? AND e.src_type = 'note' AND e.relation = 'mentions'
         AND e.dst_id IN (${ph}) AND e.src_id != ?
         AND n.category = 'idea' AND n.created_at >= datetime('now', '-90 days')
       GROUP BY e.src_id ORDER BY shared DESC, n.created_at DESC LIMIT 10`
    )
      .bind(note.user_id, ...ents, note.id)
      .all<{ note_id: string; shared: number; thread_id: string | null }>();
    const rows = results ?? [];
    console.log(`graph: mate candidates note=${note.id} rows=${rows.length} top_shared=${rows[0]?.shared ?? 0}`);
    if (rows.length === 0) return null;
    // prefer a candidate already in a thread among the top-shared ties
    const topShared = rows[0].shared;
    const top = rows.find((r) => r.shared === topShared && r.thread_id) ?? rows[0];
    if (top.shared >= 2) return top;
    // single shared entity: require a strong entity-entity relation between
    // this note's entities and the candidate note's entities (both sides)
    const mateEnts = await noteEntityIds(env, top.note_id);
    if (mateEnts.length === 0) return null;
    const mph = mateEnts.map(() => "?").join(",");
    const strong = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM edges
       WHERE user_id = ? AND src_type = 'entity' AND dst_type = 'entity' AND confidence >= ?
         AND ((src_id IN (${ph}) AND dst_id IN (${mph})) OR (src_id IN (${mph}) AND dst_id IN (${ph})))`
    )
      .bind(note.user_id, STRONG_EDGE_CONF, ...ents, ...mateEnts, ...mateEnts, ...ents)
      .first<{ c: number }>();
    if ((strong?.c ?? 0) > 0) return top;
    return null;
  } catch (err) {
    console.error(`graph: thread-mate lookup failed for note=${note.id}`, err);
    return null;
  }
}

export interface ThreadGraph {
  entities: { id: string; name: string; type: string; note_count: number }[];
  relations: { src: string; src_id: string; relation: string; relation_label: string; dst: string; dst_id: string; confidence: number; note_id: string | null }[];
  /** entity → note mention pairs within this thread, for graph highlighting. */
  mentions: { entity_id: string; note_id: string }[];
}

/** Entities mentioned by a thread's notes + entity-entity relations among them (for the detail view). */
export async function getThreadGraph(env: Env, userId: string, noteIds: string[]): Promise<ThreadGraph> {
  if (noteIds.length === 0) return { entities: [], relations: [], mentions: [] };
  const ph = noteIds.map(() => "?").join(",");
  const { results: ents } = await env.DB.prepare(
    `SELECT en.id, en.name, en.type, COUNT(DISTINCT e.src_id) AS note_count
     FROM edges e JOIN entities en ON en.id = e.dst_id
     WHERE e.user_id = ? AND e.src_type = 'note' AND e.relation = 'mentions' AND e.src_id IN (${ph})
     GROUP BY en.id ORDER BY note_count DESC, en.name ASC LIMIT 30`
  )
    .bind(userId, ...noteIds)
    .all<{ id: string; name: string; type: string; note_count: number }>();
  const entities = ents ?? [];
  if (entities.length === 0) return { entities: [], relations: [], mentions: [] };
  const ids = entities.map((e) => e.id);
  const nameById = new Map(entities.map((e) => [e.id, e.name]));
  const eph = ids.map(() => "?").join(",");
  const { results: rels } = await env.DB.prepare(
    `SELECT src_id, dst_id, relation, confidence, note_id FROM edges
     WHERE user_id = ? AND src_type = 'entity' AND dst_type = 'entity'
       AND src_id IN (${eph}) AND dst_id IN (${eph})
     ORDER BY confidence DESC LIMIT 30`
  )
    .bind(userId, ...ids, ...ids)
    .all<{ src_id: string; dst_id: string; relation: string; confidence: number; note_id: string | null }>();
  const relations = (rels ?? []).map((r) => ({
    src: nameById.get(r.src_id) ?? "?",
    src_id: r.src_id,
    relation: r.relation,
    relation_label: RELATION_LABEL[r.relation] ?? r.relation,
    dst: nameById.get(r.dst_id) ?? "?",
    dst_id: r.dst_id,
    confidence: r.confidence,
    note_id: r.note_id,
  }));
  const { results: ments } = await env.DB.prepare(
    `SELECT src_id AS note_id, dst_id AS entity_id FROM edges
     WHERE user_id = ? AND src_type = 'note' AND relation = 'mentions'
       AND src_id IN (${ph}) AND dst_id IN (${eph}) LIMIT 200`
  )
    .bind(userId, ...noteIds, ...ids)
    .all<{ note_id: string; entity_id: string }>();
  const mentions = (ments ?? []).map((m) => ({ entity_id: m.entity_id, note_id: m.note_id }));
  return { entities, relations, mentions };
}

export interface GraphExpansion {
  note_ids: string[];
  /** Human-readable triples describing why the extra notes are related. */
  triples: string[];
}

/**
 * GraphRAG 1-hop expansion for /api/ask: from recalled notes, walk to their
 * entities and bring back other notes mentioning the same entities (ranked by
 * shared-entity count), plus relation triples for the prompt. Never throws.
 */
export async function graphExpand(
  env: Env,
  userId: string,
  noteIds: string[],
  limit = 5,
  hintQuery = ""
): Promise<GraphExpansion> {
  try {
    if (noteIds.length === 0) return { note_ids: [], triples: [] };
    const ph = noteIds.map(() => "?").join(",");
    const { results: ents } = await env.DB.prepare(
      `SELECT DISTINCT dst_id FROM edges
       WHERE user_id = ? AND src_type = 'note' AND relation = 'mentions' AND src_id IN (${ph})`
    )
      .bind(userId, ...noteIds)
      .all<{ dst_id: string }>();
    const entityIds = (ents ?? []).map((r) => r.dst_id).slice(0, 30);
    if (entityIds.length === 0) return { note_ids: [], triples: [] };
    const expanded = new Set(entityIds);
    // walk strong entity-entity edges: neighbors of recalled entities join the
    // set so genuinely multi-hop fragments (A→B→note) become reachable
    {
      const p = entityIds.map(() => "?").join(",");
      const { results: nbrs } = await env.DB.prepare(
        `SELECT src_id, dst_id FROM edges
         WHERE user_id = ? AND src_type = 'entity' AND dst_type = 'entity' AND confidence >= ?
           AND (src_id IN (${p}) OR dst_id IN (${p}))
         ORDER BY confidence DESC LIMIT 20`
      )
        .bind(userId, STRONG_EDGE_CONF, ...entityIds, ...entityIds)
        .all<{ src_id: string; dst_id: string }>();
      for (const r of nbrs ?? []) {
        if (expanded.size >= 40) break;
        expanded.add(r.src_id);
        expanded.add(r.dst_id);
      }
    }
    // name-vector similar entities (cross-type) join too: extraction often
    // splits one topic into near-duplicate nodes (“咖啡豆供应链” vs
    // “咖啡豆供应商”) that no edge connects
    {
      const { results: all } = await env.DB.prepare(
        "SELECT id, vector FROM entities WHERE user_id = ? AND vector IS NOT NULL"
      )
        .bind(userId)
        .all<{ id: string; vector: string }>();
      const rows = all ?? [];
      const seedVecs: number[][] = [];
      for (const r of rows) {
        if (!expanded.has(r.id)) continue;
        try {
          seedVecs.push(JSON.parse(r.vector) as number[]);
        } catch {
          /* skip */
        }
      }
      if (seedVecs.length > 0) {
        for (const r of rows) {
          if (expanded.has(r.id) || expanded.size >= 40) continue;
          try {
            const v = JSON.parse(r.vector) as number[];
            if (seedVecs.some((s) => cosineSim(s, v) >= ENTITY_EXPAND_SIM)) expanded.add(r.id);
          } catch {
            /* skip */
          }
        }
      }
    }
    const allEntityIds = [...expanded].slice(0, 40);
    const eph = allEntityIds.map(() => "?").join(",");
    // rank: shared-entity count first, then entity specificity (rare entities
    // are stronger bridges than hubs mentioned everywhere), then recency —
    // without the tiebreaks, specific bridge notes lose ties arbitrarily
    const { results: hits } = await env.DB.prepare(
      `SELECT e.src_id AS note_id, COUNT(DISTINCT e.dst_id) AS shared,
              SUM(1.0 / MAX(en.note_count, 1)) AS spec
       FROM edges e JOIN notes n ON n.id = e.src_id JOIN entities en ON en.id = e.dst_id
       WHERE e.user_id = ? AND e.src_type = 'note' AND e.relation = 'mentions'
         AND e.dst_id IN (${eph}) AND e.src_id NOT IN (${ph})
         AND n.is_sensitive = 0
       GROUP BY e.src_id ORDER BY shared DESC, spec DESC, n.created_at DESC LIMIT ?`
    )
      .bind(userId, ...allEntityIds, ...noteIds, limit)
      .all<{ note_id: string; shared: number }>();
    const extra = (hits ?? []).map((h) => h.note_id);
    // semantic bridge: the recalled entities' names as a query over note
    // vectors picks up fragments about the same topic that share no entity
    // node at all (extraction granularity varies note to note)
    {
      const { results: seedRows } = await env.DB.prepare(
        `SELECT name FROM entities WHERE user_id = ? AND id IN (${entityIds.map(() => "?").join(",")}) LIMIT 8`
      )
        .bind(userId, ...entityIds)
        .all<{ name: string }>();
      const names = (seedRows ?? []).map((r) => r.name);
      if (names.length > 0) {
        const bridgeQuery = [hintQuery, ...names].filter(Boolean).join(" ");
        const semHits = await semanticRecall(env, userId, bridgeQuery, limit * 2, 0.45);
        for (const h of semHits) {
          if (extra.length >= limit + 2) break;
          if (!noteIds.includes(h.note_id) && !extra.includes(h.note_id)) extra.push(h.note_id);
        }
      }
    }
    // relation triples among the touched entities, for answer justification
    const { results: rels } = await env.DB.prepare(
      `SELECT s.name AS src, e.relation, d.name AS dst
       FROM edges e JOIN entities s ON s.id = e.src_id JOIN entities d ON d.id = e.dst_id
       WHERE e.user_id = ? AND e.src_type = 'entity' AND e.dst_type = 'entity'
         AND (e.src_id IN (${eph}) OR e.dst_id IN (${eph}))
       ORDER BY e.confidence DESC LIMIT 10`
    )
      .bind(userId, ...allEntityIds, ...allEntityIds)
      .all<{ src: string; relation: string; dst: string }>();
    const triples = (rels ?? []).map((r) => `${r.src} —${RELATION_LABEL[r.relation] ?? r.relation}→ ${r.dst}`);
    return { note_ids: extra, triples };
  } catch (err) {
    console.error("graph: expand failed", err);
    return { note_ids: [], triples: [] };
  }
}

/**
 * Cron backfill: extract graph data for notes that were never processed
 * (meta.graph_extracted_at absent), a few per run to respect LLM rate limits.
 */
export async function backfillGraphExtracts(env: Env, limit = 3): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM notes
     WHERE is_sensitive = 0 AND deleted_at IS NULL AND category IS NOT NULL
       AND (meta IS NULL OR meta NOT LIKE '%graph_extracted_at%')
     ORDER BY created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all<NoteRow>();
  let done = 0;
  for (const n of results ?? []) {
    await extractGraph(env, n);
    done++;
  }
  if (done > 0) console.log(`graph: backfilled ${done} extractions`);
  return done;
}
