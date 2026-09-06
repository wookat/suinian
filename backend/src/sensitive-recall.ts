// R326（docs/decision-r326.md §2）：敏感笔记的找回通道。
//
// 数据层标注（notes.is_sensitive）是唯一安全开关：标注为敏感的笔记正文以密文
// 落库、明文列只剩 ENC_PLACEHOLDER，SQL LIKE 对它无从命中，于是 R325 观测到
// 「被自动标敏感的普通笔记问答零召回、搜索搜不到」。这里把找回与 AI 出口分开：
// 密文只在本请求内解密用于**匹配**，返回给调用方的行对象仍是库内原样（正文 =
// 占位串），明文只以 plains 形式交给末端复核闭包，请求结束即销毁；模型上下文、
// 序列化、日志都拿不到明文。
import type { NoteRow } from "./types";
import { decryptContent } from "./crypto";

/** 引用卡片 / ask notes[] 里敏感条目的正文占位（前端按 id 点开取原文）。 */
export const SENSITIVE_CARD_PLACEHOLDER = "[敏感笔记：正文已加密保护，点开卡片查看原文]";
/** 模型上下文里敏感条目唯一可见的一行（不含任何原文派生物）。 */
export const SENSITIVE_MODEL_LINE = "〔敏感笔记：正文已加密，不提供给 AI；答案里只需引用它的序号让用户点开查看〕";
/** 只命中敏感笔记时的确定性答案（不调模型）。 */
export function sensitiveOnlyAnswer(count: number, refs: Array<{ index: number }>): string {
  const marks = refs.map((r) => `[${r.index}]`).join("");
  return count === 1
    ? `找到 1 条相关的敏感笔记，正文已加密保护、不会由 AI 复述；点开下方引用卡片即可查看原文${marks}`
    : `找到 ${count} 条相关的敏感笔记，正文已加密保护、不会由 AI 复述；点开下方引用卡片即可查看原文${marks}`;
}
/** 混合命中时模型没引到的敏感笔记，用这一行补角标。 */
export function sensitiveUncitedLine(refs: Array<{ index: number }>): string {
  const marks = refs.map((r) => `[${r.index}]`).join("");
  return `另有 ${refs.length} 条相关的敏感笔记（正文已加密，AI 不复述），点开引用卡片查看原文${marks}`;
}

/** 敏感笔记扫描窗口：按创建时间倒序最多解密这么多条（WebCrypto 毫秒级）。 */
export const SENSITIVE_SCAN_LIMIT = 300;
/** 每问最多给出的敏感引用卡数。 */
export const SENSITIVE_CARD_LIMIT = 5;

export interface SensitiveRecall {
  /** 命中的敏感笔记，库内原样（content 仍是占位串，未解密）。 */
  rows: NoteRow[];
  /** 本请求内解密得到的明文，只供末端复核；不得进入任何输出或模型上下文。 */
  plains: Map<string, string>;
  /** 命中但因上限未返回的条数。 */
  overflow: number;
}

const EMPTY: SensitiveRecall = { rows: [], plains: new Map(), overflow: 0 };

const CJK_RUN_RE = /^[\u4e00-\u9fff]+$/;
// 整句型 CJK 检索词（关键词抽取模型不可用 / 降级时 extractAskTerms 会把整问当一个词）
// 剥掉的问句虚词：疑问尾缀、称谓、结构助词。
const CJK_QUESTION_NOISE_RE = /(是多少|是什么|是啥|是哪个|是哪些|叫什么|多少|什么|哪个|哪些|怎么|如何|记得|还有|一下|来着|的话|呢|吗|啊|嘛|呀|吧|了|的|我的|我|你|请|帮|查|找|看)/g;

/** 整句型 CJK 词剥虚词后的二元组覆盖率（普通笔记靠语义向量兜这种情况；敏感笔记没有向量，只能子串近似）。 */
function cjkBigramCoverage(hay: string, term: string): number {
  const core = term.replace(CJK_QUESTION_NOISE_RE, "");
  if (core.length < 2) return 0;
  if (hay.includes(core)) return 1;
  const grams = new Set<string>();
  for (let i = 0; i + 2 <= core.length; i++) grams.add(core.slice(i, i + 2));
  let hits = 0;
  for (const g of grams) if (hay.includes(g)) hits += 1;
  return hits < 2 ? 0 : hits / grams.size;
}

/** 「包含」语义；整句型 CJK 词（≥4 字）额外接受二元组覆盖 ≥ 1/2。 */
function hasTerm(hay: string, term: string): boolean {
  if (term.length === 0) return false;
  const t = term.toLowerCase();
  if (hay.includes(t)) return true;
  if (t.length >= 4 && CJK_RUN_RE.test(t)) return cjkBigramCoverage(hay, t) >= 0.5;
  return false;
}

/**
 * 命中判定（与普通笔记 LIKE 召回同为「包含」OR 语义，按命中词数排序）：至少一个
 * 话题词命中即算，得分 = 命中词数。话题词 = 剥掉时间 / 聚合 / 称谓等虚词后的词，
 * 归因只认话题词，避免「问家里 wifi 引到跳板机」（audit-r325 U2）。
 */
export function sensitiveTermScore(plain: string, tagsJson: string | null, terms: string[], topicTerms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = `${plain}\n${tagsJson ?? ""}`.toLowerCase();
  const hits = terms.filter((t) => hasTerm(hay, t));
  if (hits.length === 0) return 0;
  if (hits.length === terms.length) return hits.length;
  const topics = topicTerms.length > 0 ? topicTerms : terms;
  return topics.some((t) => hasTerm(hay, t)) ? hits.length : 0;
}

/**
 * 在用户的敏感笔记里按检索词做解密内存匹配。返回行对象不解密。
 * 无加密密钥 / 明文存储回退（content_enc 为空）时按库内 content 匹配。
 */
export async function recallSensitiveNotes(
  env: { DB: D1Database; SUINIAN_ENC_KEY?: string },
  userId: string,
  terms: string[],
  opts: { topicTerms?: string[]; limit?: number; scanLimit?: number } = {}
): Promise<SensitiveRecall> {
  const qTerms = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (qTerms.length === 0) return EMPTY;
  const limit = opts.limit ?? SENSITIVE_CARD_LIMIT;
  const scanLimit = opts.scanLimit ?? SENSITIVE_SCAN_LIMIT;
  const topicTerms = (opts.topicTerms ?? []).filter((t) => t.length > 0);
  let rows: NoteRow[];
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?"
    )
      .bind(userId, scanLimit)
      .all<NoteRow>();
    rows = results ?? [];
  } catch (err) {
    console.error("sensitive-recall: scan failed", err);
    return EMPTY;
  }
  if (rows.length === 0) return EMPTY;
  const scored: Array<{ row: NoteRow; plain: string; score: number }> = [];
  for (const row of rows) {
    let plain: string | null = null;
    if (row.content_enc && env.SUINIAN_ENC_KEY) {
      try {
        plain = await decryptContent(env.SUINIAN_ENC_KEY, row.content_enc);
      } catch {
        plain = null;
      }
    }
    if (plain === null) plain = row.content ?? "";
    const score = sensitiveTermScore(plain, row.tags, qTerms, topicTerms);
    if (score > 0) scored.push({ row, plain, score });
  }
  if (scored.length === 0) return EMPTY;
  scored.sort((a, b) => b.score - a.score || (a.row.created_at < b.row.created_at ? 1 : -1));
  const kept = scored.slice(0, limit);
  const plains = new Map<string, string>();
  for (const k of kept) plains.set(k.row.id, k.plain);
  return { rows: kept.map((k) => k.row), plains, overflow: scored.length - kept.length };
}

/**
 * 末端复核（纵深，不是边界）：答案与本次召回的敏感明文做归一化比对，任一明文行
 * （≥ minLen 个实义字符）出现在答案里即视为泄漏。模型没见过明文，理论上不可能
 * 命中；用来抓实现回归。问句自带的片段不计（用户自供）。
 */
export function sensitiveAnswerLeak(answer: string, plains: Iterable<string>, question = "", minLen = 6): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const a = norm(answer);
  if (a.length === 0) return false;
  const q = norm(question);
  const leaked = (frag: string) => frag.length >= minLen && !q.includes(frag) && a.includes(frag);
  for (const plain of plains) {
    // 值形态片段（字母数字串 / 数字串，含分隔符变体归一化后）单独比对：
    // 「口令是 kq7#VB2X」这种只复述值不复述整行的也算
    for (const tok of plain.match(/[A-Za-z0-9][A-Za-z0-9#@$%_\-!.\s]*[A-Za-z0-9]/g) ?? []) {
      if (leaked(norm(tok))) return true;
    }
    for (const line of plain.split(/\r?\n/)) {
      const l = norm(line);
      if (l.length < minLen) continue;
      if (q.includes(l)) continue;
      if (a.includes(l)) return true;
      // 长行：任一连续 8 字窗口重合也算
      if (l.length > 16) {
        for (let i = 0; i + 8 <= l.length; i += 1) {
          if (leaked(l.slice(i, i + 8))) return true;
        }
      }
    }
  }
  return false;
}
