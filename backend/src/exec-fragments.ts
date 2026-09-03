// R308 P0-1：跨笔记分片投放的落库标记（audit-r307 §17 第 4 项，R18a/b/c）。
// 判定单元是「同账号邻近笔记的有序拼接」（prompt-armor.fragmentExecNoteIds），
// 结果写进 meta.exec_fragment，所有出口经 noteRowContainsExecutableCommand /
// execOutletTag 与内容判定同口径读取。只增标不撤标：分片被删或改写后其余
// 分片仍保留标记（保守），撤标须人工。
import type { Env, NoteMeta } from "./types";
import {
  FRAG_MAX_LEN,
  fragmentCandidateShape,
  fragmentExecNoteIds,
  noteMetaExecFragment,
  type FragmentCandidate,
} from "./prompt-armor";
import { recordOutletExecMarks } from "./guard-events";

/** 单条写入后复判的邻近窗口：滑窗 6 的两倍，覆盖新笔记落在窗口任一位置。 */
export const FRAG_REJUDGE_RECENT = 12;
/**
 * R310 P1：分片之间夹入无关笔记（买菜/咖啡）把「最近 12 条」窗口顶满即整族免判
 * （audit-r309 §14.3）。扫描面放宽到最近 FRAG_REJUDGE_SCAN 条，再取其中**具备分片形态**
 * （代码/地址残片、还原说明、密文样串）的最近 FRAG_REJUDGE_RECENT 条作判定序列——
 * 无关的自然语言笔记不占窗口。判定本身另有 CPU 预算（prompt-armor FRAG_*_BUDGET）。
 */
export const FRAG_REJUDGE_SCAN = 48;
/** 批量导入/恢复时的分块大小（含重叠），控制单次 CPU 预算。 */
const FRAG_BULK_CHUNK = 60;
const FRAG_BULK_OVERLAP = 6;

interface FragRow {
  id: string;
  content: string;
  meta: string | null;
  created_at: string;
}

function markStmts(db: D1Database, rows: FragRow[], hit: Set<string>): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  for (const r of rows) {
    if (!hit.has(r.id) || noteMetaExecFragment(r.meta)) continue;
    out.push(
      db
        .prepare("UPDATE notes SET meta = json_set(coalesce(meta, '{}'), '$.exec_fragment', json('true')) WHERE id = ?")
        .bind(r.id)
    );
  }
  return out;
}

/**
 * 单条笔记写入/改写后：取该账号最近 FRAG_REJUDGE_RECENT 条非敏感短笔记按时间
 * 顺序拼接复判，命中者落 meta.exec_fragment。绝不抛错（写入主流程不受影响）。
 * 返回本次新增标记的笔记 id。
 */
export async function rejudgeExecFragmentsRecent(
  env: Pick<Env, "DB">,
  userId: string,
  waitUntil?: (p: Promise<unknown>) => void
): Promise<string[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, content, meta, created_at FROM notes
       WHERE user_id = ? AND deleted_at IS NULL AND is_sensitive = 0 AND length(content) <= ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
      .bind(userId, FRAG_MAX_LEN, FRAG_REJUDGE_SCAN)
      .all<FragRow>();
    const scanned = (results ?? []).reverse();
    const candidates = scanned.filter((r) => fragmentCandidateShape(r.content)).slice(-FRAG_REJUDGE_RECENT);
    if (candidates.length < 2) return [];
    const hit = fragmentExecNoteIds(candidates as FragmentCandidate[]);
    const stmts = markStmts(env.DB, scanned, hit);
    if (stmts.length === 0) return [];
    await env.DB.batch(stmts);
    recordOutletExecMarks(env, "fragment", stmts.length, waitUntil);
    return scanned.filter((r) => hit.has(r.id) && !noteMetaExecFragment(r.meta)).map((r) => r.id);
  } catch (err) {
    console.error(`exec-fragments: recent rejudge failed user=${userId}`, err);
    return [];
  }
}

/**
 * 批量入库（导入/备份恢复）后：对给定 id 集合按 created_at 顺序分块（块间重叠
 * FRAG_BULK_OVERLAP）复判。导入笔记保留原始 created_at，「最近 N 条」窗口覆盖
 * 不到，故按 id 集合处理。绝不抛错。
 */
export async function rejudgeExecFragmentsBulk(
  env: Pick<Env, "DB">,
  ids: string[],
  waitUntil?: (p: Promise<unknown>) => void
): Promise<number> {
  if (ids.length < 2) return 0;
  try {
    const rows: FragRow[] = [];
    for (let i = 0; i < ids.length; i += 90) {
      const slice = ids.slice(i, i + 90);
      const { results } = await env.DB.prepare(
        `SELECT id, content, meta, created_at FROM notes
         WHERE id IN (${slice.map(() => "?").join(",")}) AND deleted_at IS NULL AND is_sensitive = 0 AND length(content) <= ?`
      )
        .bind(...slice, FRAG_MAX_LEN)
        .all<FragRow>();
      rows.push(...(results ?? []));
    }
    rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
    const hit = new Set<string>();
    for (let start = 0; start < rows.length; start += FRAG_BULK_CHUNK - FRAG_BULK_OVERLAP) {
      const chunk = rows.slice(start, start + FRAG_BULK_CHUNK);
      for (const id of fragmentExecNoteIds(chunk as FragmentCandidate[])) hit.add(id);
      if (start + FRAG_BULK_CHUNK >= rows.length) break;
    }
    const stmts = markStmts(env.DB, rows, hit);
    if (stmts.length === 0) return 0;
    for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
    recordOutletExecMarks(env, "fragment", stmts.length, waitUntil);
    return stmts.length;
  } catch (err) {
    console.error("exec-fragments: bulk rejudge failed", err);
    return 0;
  }
}

/** 已解析 meta 上的分片标记读取（前端/序列化侧同口径）。 */
export function metaHasExecFragment(meta: NoteMeta | null): boolean {
  return meta?.exec_fragment === true;
}
