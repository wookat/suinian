import type { Env, NoteRow } from "./types";
import { chatComplete } from "./ai";
import { findGraphThreadMate } from "./graph";
import { ensureNoteEmbedding, cosineSim, noteHasSemanticSignal } from "./semantic";
import {
  foldOutletTag,
  noteContainsExecutableCommand,
  noteRowBroadFoldReason,
  closeAggregateOutlet,
  redactGuardedViewForModel,
  broadFoldReason,
  EXEC_OUTLET_WARN_TAG,
  BROAD_OUTLET_FOLD_TAG,
  titleCarriesAnyGuardedValue,
} from "./prompt-armor";
import { recordOutletFoldMarks, recordOutletVerbatimClosed } from "./guard-events";

// re-export for existing consumers (graph.ts, tests); the implementation
// lives in semantic.ts next to the vector-store write path
export { cosineSim };

/** bge-m3 cosine similarity above which two ideas join the same thread directly. */
const SIM_JOIN = 0.76;
/**
 * Unified similarity floor above which the LLM is asked to confirm a
 * borderline match (R106, from the audit-r105 §3.2 A/B: on the same corpus a
 * 0.5 idea-side floor confirmed 11 mis-joined pairs — pair precision 59.3% —
 * while a uniform 0.62 floor reached 84.2% precision at unchanged 88.9%
 * recall). Applies to every pair (idea and collect alike) and to both the
 * request path and the frugal cron backfill.
 *
 * R188（audit-r187 P2-2 聚类召回保守）：同语料离线 A/B——floor 0.62 只试单一
 * 最佳候选时 pair recall 12.9%（precision 92.9%），floor 0.58 + 带内 top-3 逐一
 * 确认时 recall 29.7%（precision 88.2%），确认调用上限 3 次/条。误合仍由确认
 * 模型兜底，故降 floor 并列试 top-3。
 */
const SIM_CONFIRM_FLOOR = 0.58;
/** 直连未达时送 LLM 确认的带内候选数上限（按相似度降序逐一确认，命中即止）。 */
const CONFIRM_TOP_K = 3;
/**
 * 游离配对下限（R190 P1-3）：带内确认落空后，再对仍游离（无线索）的候选在
 * [LEFTOVER_FLOOR, SIM_CONFIRM_FLOOR) 低带内做严格口径确认配对。跨类别混合
 * 语料离线 A/B（scripts/thread-eligibility-eval.ts）：基线 pair recall 47.1%
 * / precision 100%、零线索主题组 2；资格解耦+低带游离配对+严格口径后
 * recall 60.8% / precision 96.9%、零线索主题组 0。
 */
const LEFTOVER_FLOOR = 0.5;
/**
 * Categories that participate in thread clustering. R190 P1-3（audit-r189
 * D-1）：聚类资格与分拣类别解耦——同一件事的推进天然横跨 idea/todo/data
 * （「装修想法→约量房→报价单」），原 idea/collect 资格把 todo/data 挡在
 * 聚类池外，是四主题组零线索的根因；财务三类（expense/income/transfer）
 * 仍不参与（记账走确定性财务路线，不是思考线索）。
 */
export const THREAD_CATEGORIES = "('idea','collect','todo','data')";
const THREAD_CATEGORY_SET = new Set(["idea", "collect", "todo", "data"]);

const CJK = "\\u4e00-\\u9fff\\u3400-\\u4dbf";
const CJK_BEFORE_LATIN = new RegExp(`([${CJK}])([A-Za-z0-9])`, "g");
const LATIN_BEFORE_CJK = new RegExp(`([A-Za-z0-9%])([${CJK}])`, "g");

/**
 * Insert the standard thin space between CJK and Latin/digit runs
 * (「掌握了C和G和弦」→「掌握了 C 和 G 和弦」) so LLM-generated titles and
 * summaries match the spacing convention used everywhere else in the app.
 */
export function spacifyCjk(s: string): string {
  return s.replace(CJK_BEFORE_LATIN, "$1 $2").replace(LATIN_BEFORE_CJK, "$1 $2");
}

type ThreadSeed = { title?: string | null; content: string; meta?: string | null };

export const UNTITLED_THREAD = "未命名线索";

/**
 * R312 P0-2：线索标题属聚合层——初始标题不再取正文前缀（R311 §6：3/19 逐字笔记原文）。候选只有来源笔记的
 * 标题，且必须通过对正文的聚合层校验（标题与任一成员正文无 ≥8 归一化字公共串）且本身不呈端点/命令/编码形态；
 * 否则回落 UNTITLED_THREAD，等 summarizeThread 的概括式标题。
 */
export function seedThreadTitle(seeds: ThreadSeed[]): string {
  for (const s of seeds) {
    const cand = (s.title ?? "").trim();
    if (!cand) continue;
    if (threadTitleVerbatim(cand, seeds.map((x) => ({ title: null, content: x.content })))) return UNTITLED_THREAD;
    return cand;
  }
  return UNTITLED_THREAD;
}

/** 标题是 ≤20 字的标签，不能局部占位：任何聚合层命中（≥ 8 字公共串 / 短载荷 token）或标题本身呈危险形态 ⇒ 整体不采用。 */
export function threadTitleVerbatim(
  title: string,
  rows: Array<{ title?: string | null; content: string; meta?: string | null }>
): boolean {
  if (broadFoldReason(title) !== null) return true;
  const units = rows.map((n) => `${n.title ?? ""}\n${n.content}`);
  // R332 P1-4：标题携带成员笔记的受守取值（短值 / 跨成员拼接的段）同样整体不采用
  return closeAggregateOutlet(title, units).count > 0 || titleCarriesAnyGuardedValue(title, units);
}

async function newThread(env: Env, userId: string, seeds: ThreadSeed[]): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO threads (id, user_id, title, note_count) VALUES (?, ?, ?, 0)"
  )
    .bind(id, userId, seedThreadTitle(seeds).slice(0, 50) || UNTITLED_THREAD)
    .run();
  return id;
}

/**
 * Generate the thread's title/summary from its notes via DeepSeek and persist
 * them. Called synchronously when clustering attaches a note (so a thread has
 * a one-line summary right away, not only after the daily cron) and reused by
 * the daily refresh. Never throws.
 */
/** 线索摘要出口的危险警示：摘要本身含命令，或线索内有危险笔记时都带标；
 * R310：只有宽判据命中（broadNotes > dangerousNotes）时带折叠短标。 */
export function threadSummaryWithExecWarn(summary: string, dangerousNotes: number, broadNotes = 0): string {
  if (summary.includes(EXEC_OUTLET_WARN_TAG)) return summary;
  if (dangerousNotes > 0 || noteContainsExecutableCommand(summary)) return `${EXEC_OUTLET_WARN_TAG} ${summary}`;
  if (summary.includes(BROAD_OUTLET_FOLD_TAG)) return summary;
  if (broadNotes > 0) return `${BROAD_OUTLET_FOLD_TAG} ${summary}`;
  return summary;
}

/**
 * R312 P0-1/P0-2：线索摘要与标题都是聚合层 AI 复述面——与任一成员笔记原文的 ≥8 归一化字公共串一律按句/行占位，
 * 无门限例外、无形态例外。标题（opts.title）不能局部占位，只报命中数由调用方整体回落。纠数用于打点。
 */
export function closeThreadSummary(
  summary: string,
  rows: Array<{ title?: string | null; content: string; meta?: string | null }>,
  opts: { title?: boolean } = {}
): { summary: string; verbatimSpans: number } {
  if (opts.title) return { summary, verbatimSpans: threadTitleVerbatim(summary, rows) ? 1 : 0 };
  const units = rows.map((n) => `${n.title ?? ""}\n${n.content}`);
  const closed = closeAggregateOutlet(summary, units);
  return { summary: closed.answer, verbatimSpans: closed.count };
}

export type SummarizeOutcome = "ok" | "empty" | "failed";

/**
 * R314 P1-4（audit-r313 §0.2-7）：返回值区分「模型无输出/超时/解析失败」（failed）与「无笔记」（empty），
 * 调用方据此重试；此前 void + 静默 return 使重建期间任何一次 8s 超时都把线索永久留在「未命名线索」，
 * 只能等次日 refreshThreads。
 */
export async function summarizeThread(env: Env, threadId: string, fallbackTitle?: string): Promise<SummarizeOutcome> {
  try {

    const { results: notes } = await env.DB.prepare(
      "SELECT title, content, meta, created_at FROM notes WHERE thread_id = ? ORDER BY created_at ASC LIMIT 50"
    )
      .bind(threadId)
      .all<{ title: string | null; content: string; meta: string | null; created_at: string }>();
    const rows = notes ?? [];
    if (rows.length === 0) return "empty";
    // R306 P0-1：摘要生成前对危险笔记打标（模型可见），摘要落库时再加警示兜底
    const reasons = rows.map((n) => noteRowBroadFoldReason(n));
    const dangerous = reasons.filter((r) => r === "strict").length;
    const broad = reasons.filter((r) => r !== null).length;
    recordOutletFoldMarks(env, "thread", { strict: dangerous, broad });
    const digest = rows
      .map((n, i) => {
        const tag = foldOutletTag(reasons[i]);
        // R322 A：受守行不进摘要模型上下文（与 /api/ask 同一套替换 + 归一化比对 fail-closed）
        const shown = redactGuardedViewForModel(n.title || n.content, `${n.title ?? ""}\n${n.content}`).text;
        return `${i + 1}. (${n.created_at.slice(0, 10)}) ${tag ? `${tag} ` : ""}${shown.slice(0, 200)}`;
      })
      .join("\n");
    const text = await chatComplete(env, {
      temperature: 0.3,
      max_tokens: 300,
      // rebuild summarize runs inside short-lived waitUntil slices: the whole
      // provider chain (primary retry + fallback) must fit one slice window
      timeout_ms: 8_000,
      messages: [
        {
          role: "system",
          content:
            '以下是同一条思考线索里按时间排列的碎片。输出严格 JSON {"title":"<=20字的线索标题","summary":"<=120字的线索脉络总结"}，只输出 JSON。要求：标题必须概括全部碎片共同的主题，用碎片中实际出现的关键词组成，禁止使用「日常工作总结」「一些想法」这类任何内容都适用的泛化标题；summary 要讲出想法从第一条到最后一条如何递进/演变（谁引出谁、哪里转向），不许把各条标题逗号串联了事。',
        },
        { role: "user", content: digest },
      ],
    });
    if (!text) return "failed";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return "failed";
    const obj = JSON.parse(m[0]) as { title?: string; summary?: string };
    if (!obj.title && !obj.summary) return "failed";
    {
      // R310 P0-1：摘要与标题都是 AI 复述面，落库前过与 Ask 相同的逐字复述收口
      const closedSummary = obj.summary ? closeThreadSummary(spacifyCjk(obj.summary), rows) : null;
      const closedTitle = closeThreadSummary(spacifyCjk((obj.title || fallbackTitle || UNTITLED_THREAD).slice(0, 50)), rows, { title: true });
      const title =
        closedTitle.verbatimSpans > 0
          ? fallbackTitle && closeThreadSummary(fallbackTitle, rows, { title: true }).verbatimSpans === 0
            ? fallbackTitle
            : UNTITLED_THREAD
          : closedTitle.summary;
      recordOutletVerbatimClosed(env, "thread", (closedSummary?.verbatimSpans ?? 0) + closedTitle.verbatimSpans);
      await env.DB.prepare(
        "UPDATE threads SET title = ?, summary = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(
          title,
          closedSummary
            ? threadSummaryWithExecWarn(closedSummary.summary, dangerous, broad)
            : dangerous > 0
              ? EXEC_OUTLET_WARN_TAG
              : broad > 0
                ? BROAD_OUTLET_FOLD_TAG
                : null,
          threadId
        )
        .run();
    }
    return "ok";
  } catch (err) {
    console.error(`threads: summarizeThread failed for thread=${threadId}`, err);
    return "failed";
  }
}

/** 重建 summarize 阶段对失败线索的补跑轮数（首轮之外）。 */
export const SUMMARIZE_RETRY_ROUNDS = 2;
/** 每次 10 分钟 cron 最多补标题的线索数（每条一次 ≤8s 模型调用）。 */
const RETITLE_SWEEP_LIMIT = 12;

/**
 * R314 P1-4：10 分钟 cron 补跑——重建 / 分拣后仍是「未命名线索」且 3 分钟内未更新过的线索
 * 再要一次标题。只挑 note_count>0、无活动重建任务的用户（任务在跑时线索归任务管）。
 * 标题仍落回「未命名」的（聚合层命中原文）会持续被扫到，但每轮最多 RETITLE_SWEEP_LIMIT 条，
 * 且 updated_at 被刷新 ⇒ 至少 3 分钟后才再试，不形成热循环。Never throws.
 */
export async function retitleUntitledThreads(env: Env, limit = RETITLE_SWEEP_LIMIT): Promise<{ scanned: number; titled: number }> {
  const out = { scanned: 0, titled: 0 };
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title FROM threads
        WHERE title = ? AND note_count > 0
          AND updated_at < datetime('now', '-3 minutes')
          AND user_id NOT IN (SELECT user_id FROM thread_jobs WHERE status IN ('queued','running'))
        ORDER BY updated_at ASC LIMIT ?`
    )
      .bind(UNTITLED_THREAD, limit)
      .all<{ id: string; title: string }>();
    for (const t of results ?? []) {
      out.scanned++;
      const r = await summarizeThread(env, t.id);
      if (r === "ok") {
        const row = await env.DB.prepare("SELECT title FROM threads WHERE id = ?").bind(t.id).first<{ title: string }>();
        if (row && row.title !== UNTITLED_THREAD) out.titled++;
      } else {
        // 失败也刷新 updated_at：下一轮 3 分钟后再试，避免同一条卡住整批
        await env.DB.prepare("UPDATE threads SET updated_at = datetime('now') WHERE id = ?").bind(t.id).run();
      }
    }
    if (out.scanned > 0) console.log(`threads: retitle sweep scanned=${out.scanned} titled=${out.titled}`);
  } catch (err) {
    console.error("threads: retitleUntitledThreads failed", err);
  }
  return out;
}

export async function attachNoteToThread(env: Env, noteId: string, threadId: string): Promise<void> {
  const prev = await env.DB.prepare("SELECT thread_id FROM notes WHERE id = ?")
    .bind(noteId)
    .first<{ thread_id: string | null }>();
  await env.DB.prepare("UPDATE notes SET thread_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(threadId, noteId)
    .run();
  await env.DB.prepare(
    "UPDATE threads SET note_count = (SELECT COUNT(*) FROM notes WHERE thread_id = ? AND deleted_at IS NULL), updated_at = datetime('now') WHERE id = ?"
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
  // 模型可能带前缀/标点（如「答案：3」「3.」）：取回复中第一个整数而非要求纯数字开头
  const m = text.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
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

/**
 * DeepSeek: confirm whether two note snippets are the same topic (borderline
 * embedding match). 统一严格口径（R192，audit-r191 D-3 校准）：只认「同一件
 * 具体的事」，体裁相似（都是缴费/预约/杂务）或表面词重叠（窗帘报价 vs 遮光
 * 窗帘助眠）不算。此前宽口径仅限 idea/collect 配对，加入 R191 硬例后离线
 * A/B（scripts/thread-eligibility-eval.ts，多次重放）：原口径 pair precision
 * 74.5% / recall 57.4%（每次一致），全部改严格口径后 precision 78.3%~90.0%
 *（确认模型对个别边界对非严格确定）/ recall 59.0%，两项均不劣于原口径。数值阈值
 *（SIM_JOIN/SIM_CONFIRM_FLOOR/LEFTOVER_FLOOR）维持不变：再收紧只损召回不换
 * 精度（floor 0.62 → 93.3%/45.9%），提 join 0.80 无增益（与严格口径同分）。
 */
async function deepseekConfirmPair(env: Env, a: string, b: string): Promise<boolean> {
  const n = await deepseekPickNumber(
    env,
    "判断下面两条笔记是否在记录同一件具体的事（同一个项目/主题的推进，可以串成同一条线索）。只是体裁相似（都是缴费、都是预约、都是杂务）或泛泛相关不算。是则输出 1，否则输出 0。只输出数字。",
    `笔记A：${a.slice(0, 400)}\n\n笔记B：${b.slice(0, 400)}`,
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
    if (!note.category || !THREAD_CATEGORY_SET.has(note.category)) return null;
    // graph signal first: an idea sharing entities/relations with an existing
    // idea joins its thread regardless of embedding similarity. Collect notes
    // skip this path: with no similarity floor, entity overlap alone (e.g. a
    // shared place name in an unrelated article) would over-join them.
    if (note.category === "idea" && !note.is_sensitive && opts?.useGraph !== false) {
      const mate = await findGraphThreadMate(env, note);
      if (mate) {
        console.log(`threads: graph mate note=${note.id} mate=${mate.note_id} shared=${mate.shared}`);
        // still store the embedding so search/ask recall keeps working
        await ensureNoteEmbedding(env, note);
        let threadId = mate.thread_id;
        if (!threadId) {
          const m = await env.DB.prepare("SELECT title, content, meta FROM notes WHERE id = ?")
            .bind(mate.note_id)
            .first<{ title: string | null; content: string; meta: string | null }>();
          threadId = await newThread(env, note.user_id, m ? [m, note] : [note]);
          await attachNoteToThread(env, mate.note_id, threadId);
        }
        await attachNoteToThread(env, note.id, threadId);
        await summarize(threadId, note.title || undefined);
        return threadId;
      }
    }
    // sensitive/zero-signal notes never enter the vector store; the shared
    // gate in ensureNoteEmbedding decides (R162 P1-1: this used to be an
    // independent embed+save path that resurrected purged emoji vectors)
    const vector = await ensureNoteEmbedding(env, note);
    if (vector) {
      type Candidate = { id: string; thread_id: string | null; category: string; title: string | null; content: string; meta: string | null; url_title: string | null; url_summary: string | null; is_sensitive: number; vector: string | null };
      // recent ideas/collects (any age cap removed) + one representative note
      // per existing thread, so historical threads stay joinable beyond the window
      const { results } = await env.DB.prepare(
        `SELECT n.id, n.thread_id, n.category, n.title, n.content, n.meta, n.url_title, n.url_summary, n.is_sensitive, e.vector FROM notes n
         LEFT JOIN note_embeddings e ON e.note_id = n.id
         WHERE n.user_id = ? AND n.category IN ${THREAD_CATEGORIES} AND n.deleted_at IS NULL AND n.id != ?
         ORDER BY n.created_at DESC LIMIT 200`
      )
        .bind(note.user_id, note.id)
        .all<Candidate>();
      const candidates: Candidate[] = [...(results ?? [])];
      try {
        const { results: reps } = await env.DB.prepare(
          `SELECT n.id, n.thread_id, n.category, n.title, n.content, n.meta, n.url_title, n.url_summary, n.is_sensitive, e.vector FROM notes n
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
      type Best = { id: string; thread_id: string | null; category: string; title: string | null; content: string; meta: string | null; sim: number };
      let best: Best | null = null;
      let bestThreaded: Best | null = null;
      const inBand: Best[] = [];
      const lowBandLoose: Best[] = [];
      let backfilled = 0;
      for (const r of candidates) {
        let v: number[] | null = null;
        if (r.vector) {
          try {
            const p = JSON.parse(r.vector) as number[];
            // '[]' sentinel = zero-signal note: not comparable, and must not
            // fall into the backfill branch below
            v = Array.isArray(p) && p.length > 0 ? p : null;
          } catch {
            v = null;
          }
        } else if (backfilled < 20) {
          // lazily embed older notes that predate the embeddings table
          backfilled++;
          v = await ensureNoteEmbedding(env, { ...r, user_id: note.user_id });
        }
        if (!v) continue;
        const sim = cosineSim(vector, v);
        const cand: Best = { id: r.id, thread_id: r.thread_id, category: r.category, title: r.title, content: r.content, meta: r.meta, sim };
        if (!best || sim > best.sim) best = cand;
        if (r.thread_id && (!bestThreaded || sim > bestThreaded.sim)) bestThreaded = cand;
        if (sim >= SIM_CONFIRM_FLOOR && sim < SIM_JOIN) inBand.push(cand);
        else if (!r.thread_id && sim >= LEFTOVER_FLOOR && sim < SIM_CONFIRM_FLOOR) lowBandLoose.push(cand);
      }
      // 已有线索优先（R150 P1-3）：当某条已入线索的笔记本身就达到直连阈值时，
      // 直接并入它的线索；否则一条相似度略高的游离笔记会抢先另起新线索，
      // 同主题被拆成两条（历史回填逐条顺序聚类下的确定性分裂源）。
      if (bestThreaded && bestThreaded.sim >= SIM_JOIN) best = bestThreaded;
      if (best) {
        let joined: Best | null = best.sim >= SIM_JOIN ? best : null;
        if (!joined) {
          // 带内 top-K 逐一送确认（R188）：只试单一最佳时，同主题次优候选会被
          // 一次否决整体埋没；命中即止，调用上限 CONFIRM_TOP_K。
          inBand.sort((a, b) => b.sim - a.sim);
          for (const cand of inBand.slice(0, CONFIRM_TOP_K)) {
            if (
              await deepseekConfirmPair(env, note.title || note.content, cand.title || cand.content)
            ) {
              joined = cand;
              break;
            }
          }
        }
        if (!joined) {
          // 低带游离配对（R190 P1-3）：只对仍无线索的候选、只用严格口径，把
          // 相似度在带下但确属同一件事的碎片配成线索（离线 A/B 中零线索主题组
          // 2→0 全部来自这一段），已有线索不参与，避免低带误并扩散。
          lowBandLoose.sort((a, b) => b.sim - a.sim);
          for (const cand of lowBandLoose.slice(0, CONFIRM_TOP_K)) {
            if (await deepseekConfirmPair(env, note.title || note.content, cand.title || cand.content)) {
              joined = cand;
              break;
            }
          }
        }
        console.log(
          `threads: cluster note=${note.id} best=${best.id} sim=${best.sim.toFixed(3)} joined=${joined ? `${joined.id}@${joined.sim.toFixed(3)}` : "none"}`
        );
        if (joined) {
          let threadId = joined.thread_id;
          if (!threadId) {
            threadId = await newThread(env, note.user_id, [joined, note]);
            await attachNoteToThread(env, joined.id, threadId);
            console.log(`threads: created thread ${threadId} for notes ${joined.id}, ${note.id}`);
          }
          await attachNoteToThread(env, note.id, threadId);
          await summarize(threadId, note.title || undefined);
          return threadId;
        }
      } else {
        console.log(`threads: cluster note=${note.id} no comparable idea notes`);
      }
      // frugal path stops here: embedding prescreen + bounded confirm calls.
      // non-idea notes also stop: the LLM-only fallbacks have no similarity
      // floor, so one-off collects/todo/data would over-join (see eval script)
      if (opts?.frugal || note.category !== "idea") return null;
      // borderline/no embedding match: still try DeepSeek against existing thread titles
      const picked = await pickThreadByDeepseek(env, note);
      if (picked) {
        await attachNoteToThread(env, note.id, picked);
        await summarize(picked, note.title || undefined);
        return picked;
      }
      return null;
    }
    if (opts?.frugal || note.category !== "idea") return null;
    // zero-signal notes (pure emoji/symbol) must not cluster at all: the
    // LLM-only fallbacks have no similarity floor and happily grouped emoji
    // notes into an「情绪变化」thread (audit-r161 P1-1)
    if (!note.is_sensitive && !noteHasSemanticSignal(note)) {
      console.log(`threads: skip zero-signal note=${note.id}`);
      return null;
    }
    // no embedding available: DeepSeek-only fallback (existing threads, then cold-start pairing)
    console.log(`threads: no embedding for note=${note.id}, using deepseek fallback`);
    const picked = await pickThreadByDeepseek(env, note);
    if (picked) {
      await attachNoteToThread(env, note.id, picked);
      await summarize(picked, note.title || undefined);
      return picked;
    }
    // cold start: no thread matched (or none exist) — pair with a recent unthreaded idea/collect note
    const { results: loose } = await env.DB.prepare(
      `SELECT id, title, content, meta FROM notes
       WHERE user_id = ? AND category IN ${THREAD_CATEGORIES} AND deleted_at IS NULL AND thread_id IS NULL AND id != ?
       ORDER BY created_at DESC LIMIT 30`
    )
      .bind(note.user_id, note.id)
      .all<{ id: string; title: string | null; content: string; meta: string | null }>();
    const mate = await deepseekPickNote(env, note.content, loose ?? []);
    if (mate) {
      const m = (loose ?? []).find((n) => n.id === mate)!;
      const threadId = await newThread(env, note.user_id, [m, note]);
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
  phase: "reset" | "cluster" | "second_pass" | "summarize" | "summarize_retry" | "done";
  /** (created_at, id) cursor within the current phase's chronological scan. */
  cursorCreatedAt: string;
  cursorId: string;
  total: number;
  processed: number;
  secondPassed: number;
  /** summarize-phase progress: threads summarized so far / to summarize. */
  summarized?: number;
  summarizeTotal?: number;
  /** R314 P1-4：summarize 阶段模型失败的线索 id，主扫描完后按轮补跑。 */
  summarizeRetry?: string[];
  summarizeRetryFailed?: string[];
  summarizeRetryRound?: number;
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
        // 重整期间异步分拣可把新笔记补进线索分类，扫描数会超过 reset 时的
        // 快照总数（R218 P3-4：processed 134 > total 123 使进度超 100%）；
        // 把 total 抬到已处理数，保持 processed ≤ total 的进度口径
        if (state.processed > state.total) state.total = state.processed;
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
        `SELECT * FROM notes WHERE user_id = ?1 AND category IN ${THREAD_CATEGORIES} AND deleted_at IS NULL AND thread_id IS NULL
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
        if ((state.summarizeRetry ?? []).length > 0) {
          state.phase = "summarize_retry";
          state.summarizeRetryRound = 0;
          return state;
        }
        return finishRebuild(env, userId, state);
      }
      for (const t of rows) {
        const r = await summarizeThread(env, t.id);
        if (r === "failed") (state.summarizeRetry ??= []).push(t.id);
        state.summarized = (state.summarized ?? 0) + 1;
        state.cursorId = t.id;
        if (Date.now() >= deadline) return state;
      }
    }
    return state;
  }
  if (state.phase === "summarize_retry") {
    // R314 P1-4：主扫描里模型超时/无输出的线索按轮补跑（每轮一次），超过轮数交给 10 分钟 cron 的 retitle 兜底
    // summarizeRetry = 本轮待跑队列；summarizeRetryFailed = 本轮已失败、留给下一轮
    while (Date.now() < deadline) {
      const pending = state.summarizeRetry ?? [];
      const failed = state.summarizeRetryFailed ?? [];
      const round = state.summarizeRetryRound ?? 0;
      if (pending.length === 0) {
        if (failed.length === 0 || round + 1 >= SUMMARIZE_RETRY_ROUNDS) {
          state.summarizeRetry = [];
          state.summarizeRetryFailed = [];
          return finishRebuild(env, userId, state);
        }
        state.summarizeRetry = failed;
        state.summarizeRetryFailed = [];
        state.summarizeRetryRound = round + 1;
        continue;
      }
      const tid = pending[0];
      const r = await summarizeThread(env, tid);
      state.summarizeRetry = pending.slice(1);
      if (r === "failed") state.summarizeRetryFailed = [...failed, tid];
    }
    return state;
  }
  return state;
}

async function finishRebuild(env: Env, userId: string, state: RebuildState): Promise<RebuildState> {
  // 摘要齐全后统一折叠重复线索（R150 P1-3）：重建过程中分裂出的同主题
  // 线索此刻标题/代表已就绪，不再等日更周期
  await mergeDuplicateThreads(env, userId);
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS c FROM threads WHERE user_id = ? AND note_count > 0")
    .bind(userId)
    .first<{ c: number }>();
  state.threads = cnt?.c ?? 0;
  state.phase = "done";
  console.log(`threads: rebuild for user=${userId} ideas=${state.total} threads=${state.threads}`);
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
 * Stock cleanup (audit-r163 P1-1): detach thread members whose user-original
 * text carries no semantic signal — they clustered while the gate was judged
 * on AI-title-included text. Affected threads are reconciled (dissolved when
 * degenerate) and re-summarized so polluted summaries heal. Idempotent.
 */
export async function detachZeroSignalThreadMembers(env: Env): Promise<number> {
  const affected = new Set<string>();
  let detached = 0;
  const BATCH = 400;
  for (let offset = 0; ; offset += BATCH) {
    const { results } = await env.DB.prepare(
      `SELECT id, thread_id, content, url_title, url_summary FROM notes
       WHERE thread_id IS NOT NULL AND deleted_at IS NULL AND is_sensitive = 0
       ORDER BY created_at ASC LIMIT ? OFFSET ?`
    )
      .bind(BATCH, offset)
      .all<Pick<NoteRow, "id" | "thread_id" | "content" | "url_title" | "url_summary">>();
    const rows = results ?? [];
    const bad = rows.filter((n) => !noteHasSemanticSignal(n));
    for (const n of bad) {
      await env.DB.prepare(
        "UPDATE notes SET thread_id = NULL, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(n.id)
        .run();
      if (n.thread_id) affected.add(n.thread_id);
      detached++;
    }
    // detached rows leave the thread_id IS NOT NULL result set, shifting later pages
    offset -= bad.length;
    if (rows.length < BATCH) break;
  }
  for (const threadId of affected) {
    try {
      const outcome = await reconcileThread(env, threadId);
      if (outcome !== "deleted" && outcome !== "dissolved") await summarizeThread(env, threadId);
    } catch (err) {
      console.error(`threads: zero-signal detach reconcile failed for thread=${threadId}`, err);
    }
  }
  if (detached > 0) console.log(`threads: detached ${detached} zero-signal thread members`);
  return detached;
}

/**
 * Merge duplicate same-topic threads (R109 P2-1, hardened R112 P1-2): two
 * notes on the same topic saved concurrently can each spawn a thread (both
 * clusterNote calls read "no thread yet" before either writes). Rather than
 * serializing ingestion, compare each thread's representative (newest
 * non-sensitive note) embedding and fold pairs at/above SIM_JOIN into the
 * older thread. A representative whose embedding hasn't been stored yet (the
 * concurrency window that let R111 reproduce the split) is embedded on demand
 * instead of skipping the thread, and a scoped scan keeps folding until the
 * surviving thread has no duplicate left. `aroundThreadId` scopes the scan to
 * one freshly-touched thread (ingest pipeline); without it every thread of
 * the user is scanned (cron sweeps). Never throws.
 */
export async function mergeDuplicateThreads(
  env: Env,
  userId: string,
  aroundThreadId?: string,
  opts?: { titleOnly?: boolean }
): Promise<number> {
  try {
    const { results } = await env.DB.prepare(
      // threads 表没有 created_at 列（R186：旧 SQL 引用不存在的列，整个合并被
      // 外层 catch 静默吞掉）：线索的诞生时间 = 最早一条在内笔记的 created_at
      `SELECT t.id, t.title,
              (SELECT MIN(n.created_at) FROM notes n WHERE n.thread_id = t.id AND n.deleted_at IS NULL) AS created_at
         FROM threads t WHERE t.user_id = ? AND t.note_count > 0 ORDER BY created_at ASC LIMIT 100`
    )
      .bind(userId)
      .all<{ id: string; created_at: string | null; title: string }>();
    // 成员全被软删的线索无诞生时间可比，交给 reconcile 处理，不参与合并
    let threads = (results ?? []).filter((t): t is { id: string; created_at: string; title: string } => t.created_at !== null);
    if (threads.length < 2) return 0;
    let merged = 0;
    // identical-title fold first (R132 D-4): two threads carrying the exact
    // same LLM-generated title are the same topic even when their newest
    // representatives drift below the embedding confirm band
    for (let i = 0; i < threads.length; i++) {
      for (let j = threads.length - 1; j > i; j--) {
        const a = threads[i];
        const b = threads[j];
        if (!a.title || a.title === "未命名线索" || a.title !== b.title) continue;
        await env.DB.prepare("UPDATE notes SET thread_id = ?, updated_at = datetime('now') WHERE thread_id = ?")
          .bind(a.id, b.id)
          .run();
        await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(b.id).run();
        await reconcileThread(env, a.id);
        threads = threads.filter((x) => x.id !== b.id);
        merged++;
        console.log(`threads: merged same-title thread ${b.id} into ${a.id} (user=${userId}, title=${a.title})`);
      }
    }
    if (opts?.titleOnly || threads.length < 2) return merged;
    type Rep = { vector: number[] | null; text: string };
    const reps = new Map<string, Rep | null>();
    const repOf = async (threadId: string): Promise<Rep | null> => {
      if (!reps.has(threadId)) {
        const row = await env.DB.prepare(
          `SELECT n.id, n.title, n.content, n.url_title, n.url_summary, e.vector
             FROM notes n LEFT JOIN note_embeddings e ON e.note_id = n.id
            WHERE n.thread_id = ? AND n.deleted_at IS NULL AND n.is_sensitive = 0
            ORDER BY n.created_at DESC LIMIT 1`
        )
          .bind(threadId)
          .first<{ id: string; title: string | null; content: string; url_title: string | null; url_summary: string | null; vector: string | null }>();
        let v: number[] | null = null;
        if (row?.vector) {
          try {
            const p = JSON.parse(row.vector) as number[];
            v = Array.isArray(p) && p.length > 0 ? p : null;
          } catch {
            v = null;
          }
        }
        if (!v && row?.vector !== "[]" && row) {
          // representative embedding not stored yet (concurrent-save window):
          // embed it now rather than silently skipping the thread
          v = await ensureNoteEmbedding(env, { ...row, user_id: userId, is_sensitive: 0 });
        }
        reps.set(threadId, row ? { vector: v, text: row.title || row.content } : null);
      }
      return reps.get(threadId)!;
    };
    // a scoped merge can leave the surviving thread with further duplicates
    // (3+ concurrent saves): keep re-scanning around the survivor until stable
    let scope = aroundThreadId;
    for (let pass = 0; pass < 5; pass++) {
      let foldedThisPass = 0;
      const targets = scope ? threads.filter((t) => t.id === scope) : threads;
      for (const t of targets) {
        const tr = await repOf(t.id);
        if (!tr?.vector) continue;
        for (const o of threads) {
          if (o.id === t.id) continue;
          const or = await repOf(o.id);
          if (!or?.vector) continue;
          const sim = cosineSim(tr.vector, or.vector);
          if (sim < SIM_JOIN) {
            // borderline pair (R113 P2): same LLM confirmation as clusterNote —
            // concurrent same-topic saves can leave two clusters whose newest
            // representatives sit just under SIM_JOIN
            if (sim < SIM_CONFIRM_FLOOR) continue;
            if (!(await deepseekConfirmPair(env, tr.text, or.text))) continue;
            console.log(`threads: merge confirmed borderline pair sim=${sim.toFixed(3)} (user=${userId})`);
          }
          // fold the newer thread into the older one
          const [keep, drop] = t.created_at <= o.created_at ? [t, o] : [o, t];
          await env.DB.prepare("UPDATE notes SET thread_id = ?, updated_at = datetime('now') WHERE thread_id = ?")
            .bind(keep.id, drop.id)
            .run();
          await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(drop.id).run();
          await reconcileThread(env, keep.id);
          reps.delete(keep.id);
          reps.delete(drop.id);
          threads = threads.filter((x) => x.id !== drop.id);
          merged++;
          foldedThisPass++;
          console.log(`threads: merged duplicate thread ${drop.id} into ${keep.id} (user=${userId})`);
          if (scope) scope = keep.id; // the scoped thread may have been folded away
          break;
        }
        if (scope && foldedThisPass > 0) break;
      }
      if (foldedThisPass === 0 || !scope) break;
    }
    return merged;
  } catch (err) {
    console.error(`threads: mergeDuplicateThreads failed for user=${userId}`, err);
    return 0;
  }
}

/**
 * Deferred duplicate-thread reconciliation (R112 P1-2): the scoped merge right
 * after clusterNote can miss a concurrent sibling whose thread/embedding was
 * written a moment later. Runs on the 10-min cron over users whose threads
 * changed recently, once every embedding involved is ready. Never throws.
 */
export async function sweepRecentDuplicateThreads(env: Env, windowMinutes = 30): Promise<number> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT user_id FROM threads WHERE updated_at >= datetime('now', ?)"
    )
      .bind(`-${windowMinutes} minutes`)
      .all<{ user_id: string }>();
    let merged = 0;
    for (const u of results ?? []) merged += await mergeDuplicateThreads(env, u.user_id);
    if (merged > 0) console.log(`threads: recent duplicate sweep merged=${merged}`);
    return merged;
  } catch (err) {
    console.error("threads: sweepRecentDuplicateThreads failed", err);
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
  // 摘要刷新后再跑一遍同标题折叠（R150 P1-3）：上面的 merge 跑在 summarize
  // 之前，刚生成的重复标题要等下一个周期才能被折叠，重复线索会在线索页
  // 可见整整一天；标题比对零成本，此处只跑 titleOnly 避免重复 embedding 扫描。
  for (const u of users ?? []) await mergeDuplicateThreads(env, u.user_id, undefined, { titleOnly: true });
}
