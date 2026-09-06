// R326（decision-r326 §1 补遗，R325 I06 / L03）：拆条投放——一条「衣柜密码明天再记，先占个位」或「昨天记的那个词，
// 就是柜子要用的那个」的**指针笔记**自身没有值，紧接着的一条「就是 铜锁春雨 这四个字」裸值笔记又没有任何称谓词，
// 任何单条内容形态识别都判不出它是凭证。这里不识别值，而是沿指针**传播**敏感标注：
// 指针笔记（凭证称谓 + 延后/回指提示，或「柜子那个词」式的弱称谓指针，且本身不含值）的标注落到相邻的那条短笔记上
// （meta.sensitive_continuation 记指针 id），applyTriage 对该标注粘性（模型不能凭「正文无秘密值」推翻），用户显式取消后放开。
// 误传播的代价只是「点开一次」（§3），不影响找回。绝不抛错，不阻断写入主流程。
import { decryptContent } from "./crypto";
import { applyNotePatch, parseNoteMeta } from "./note-store";
import { detectSensitive, hasSensitiveTopic } from "./triage";
import type { Env, NoteRow } from "./types";

/** 指针笔记与裸值笔记之间允许的最大间隔。 */
export const CONTINUATION_WINDOW_MS = 30 * 60 * 1000;
/** 裸值笔记的长度上限：值 + 几个连接词；长于此的是正常散文，不传播。 */
export const CONTINUATION_MAX_LEN = 40;
/** 指针笔记之后最多隔几条仍算「紧接着」。 */
const CONTINUATION_LOOKBACK = 2;

/** 「值另记一条」的延后提示：明天再记 / 先占个位 / 分开记 / 下一条…… */
const DEFER_CUE_RE =
  /再记|再写|再补|补上|占个?位|先占|分开记|单独记|另记|另外记|另一条|下一?条|拆开记|后面(?:那|一)?条|later|separately|in (?:the )?next (?:note|one)|next note/i;
/** 「那条就是值」的回指提示：上一条 / 上面那条 / 刚发的 / 昨天记的那个…… */
const BACKREF_CUE_RE =
  /上一?条|上面那条|前一?条|刚才那条|刚发的|刚记的|(?:昨天|之前|前面|刚)记的那|previous note|last note|the one above/i;
/**
 * 弱称谓指针：可上锁对象 + 「那个词 / 那串 / 那几位 / 要用的那个」，不带值（带值的是 triage 的 WEAK_LABEL_ASSIGN）。
 * 「昨天记的那个词，就是柜子要用的那个」——没有任何凭证称谓词，但它就是在指另一条笔记里的开锁词。
 */
const WEAK_KEY_POINTER_RE =
  /(?:柜子?|储物柜|保险柜|快递柜|衣柜|路由器|门禁|大门|仓库|信箱|车库|锁)[^\n]{0,8}?(?:那个词|那几个字|那串|那组|那几位|那个数|那个码|(?:要|得|得用|要用|用)的那个)|(?:word|combo|combination|code)\s+for\s+(?:the\s+|my\s+)?(?:locker|safe|vault|door|gate|garage|wifi|wi-fi|router|lock|padlock|cabinet|closet)\b/iu;

/** 指针笔记：本身不含凭证值（含值的由 detectSensitive 直接定论），且指向另一条笔记里的值。 */
export function isContinuationPointer(plain: string): boolean {
  if (detectSensitive(plain)) return false;
  if (WEAK_KEY_POINTER_RE.test(plain)) return true;
  return hasSensitiveTopic(plain) && (DEFER_CUE_RE.test(plain) || BACKREF_CUE_RE.test(plain));
}

/** @deprecated 测试用细粒度入口；主流程用 isContinuationPointer。 */
export function isDeferredPointer(plain: string): boolean {
  return !detectSensitive(plain) && hasSensitiveTopic(plain) && DEFER_CUE_RE.test(plain);
}

export function isBackrefPointer(plain: string): boolean {
  return !detectSensitive(plain) && hasSensitiveTopic(plain) && BACKREF_CUE_RE.test(plain);
}

function manuallyUnmarked(n: NoteRow): boolean {
  return !n.is_sensitive && parseNoteMeta(n.meta)?.manual_override?.is_sensitive === true;
}

/** 裸值笔记形态：单行短文本（不看内容是什么，只看长度）。 */
export function continuationShape(content: string): boolean {
  const t = content.trim();
  return t.length > 0 && t.length <= CONTINUATION_MAX_LEN && !t.includes("\n");
}

function parseServerTime(s: string): number {
  const t = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : 0;
}

async function plainOf(env: Pick<Env, "SUINIAN_ENC_KEY">, n: NoteRow): Promise<string> {
  if (n.is_sensitive && n.content_enc && env.SUINIAN_ENC_KEY) {
    const p = await decryptContent(env.SUINIAN_ENC_KEY, n.content_enc);
    if (p !== null) return p;
  }
  return n.content;
}

async function markContinuation(env: Pick<Env, "DB" | "SUINIAN_ENC_KEY" | "MEDIA">, target: NoteRow, peerId: string): Promise<boolean> {
  const meta = { ...(parseNoteMeta(target.meta) ?? {}), sensitive_continuation: peerId };
  const r = await applyNotePatch(
    env,
    env.DB,
    {
      id: target.id,
      user_id: target.user_id,
      updated_at: target.updated_at,
      is_sensitive: target.is_sensitive ? 1 : 0,
      content: target.content,
      content_enc: target.content_enc,
      tags: target.tags,
      meta: target.meta,
    },
    { is_sensitive: true, meta }
  );
  return r.changes > 0;
}

/**
 * 单条笔记写入后：把相邻指针笔记的敏感标注传播到裸值笔记上。
 *  - 正向：新笔记是短裸值，且它前面 CONTINUATION_LOOKBACK 条内有一条指针（未被用户显式取消标记）→ 标新笔记；
 *  - 反向：新笔记本身是指针（「上一条就是衣柜密码」）→ 标紧邻的那条短笔记。
 * 指针 / 裸值自身是否已标敏感都不作前提：指针里没有值，模型复判很可能已把它降级；裸值若已被规则 / 模型标敏感，
 * 指针仍需跟着标（否则指针以明文进 AI 出口，直接点名了旁边那张卡片里是什么凭证）。
 * 传播成立后指针与裸值视为同一条拆开记的凭证：两条都标敏感并互记对方 id，模型复判不得单独降级其中一条
 * （否则指针以明文进 AI 出口，它直接点名了旁边那张卡片里是什么凭证）。
 * 返回本次新增标注的笔记 id（裸值在前，指针在后）。
 */
export async function propagateSensitiveContinuation(
  env: Pick<Env, "DB" | "SUINIAN_ENC_KEY" | "MEDIA">,
  userId: string,
  noteId: string
): Promise<string[]> {
  try {
    const fresh = await env.DB.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ?").bind(noteId, userId).first<NoteRow>();
    if (!fresh || fresh.deleted_at) return [];
    const { results } = await env.DB.prepare(
      `SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL AND id != ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`
    )
      .bind(userId, noteId, CONTINUATION_LOOKBACK)
      .all<NoteRow>();
    const t0 = parseServerTime(fresh.created_at);
    const prior = (results ?? []).filter((n) => Math.abs(t0 - parseServerTime(n.created_at)) <= CONTINUATION_WINDOW_MS);
    if (prior.length === 0) return [];

    const marked: string[] = [];
    const pin = async (carrier: NoteRow, pointer: NoteRow) => {
      if (!(await markContinuation(env, carrier, pointer.id))) return;
      marked.push(carrier.id);
      if (!pointer.is_sensitive || !parseNoteMeta(pointer.meta)?.sensitive_continuation) {
        if (await markContinuation(env, pointer, carrier.id)) marked.push(pointer.id);
      }
    };
    const freshPlain = await plainOf(env, fresh);
    if (!manuallyUnmarked(fresh) && continuationShape(freshPlain) && !isContinuationPointer(freshPlain)) {
      for (const p of prior) {
        if (manuallyUnmarked(p)) continue;
        if (!isContinuationPointer(await plainOf(env, p))) continue;
        await pin(fresh, p);
        break;
      }
    } else if (!manuallyUnmarked(fresh) && isContinuationPointer(freshPlain)) {
      const prev = prior[0];
      if (!manuallyUnmarked(prev) && continuationShape(await plainOf(env, prev))) await pin(prev, fresh);
    }
    return marked;
  } catch (err) {
    console.error(`sensitive-continuation: propagate failed user=${userId} note=${noteId}`, err);
    return [];
  }
}
