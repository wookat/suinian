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
import { foldHanVariants } from "./prompt-armor";

/** 引用卡片 / ask notes[] 里敏感条目的正文占位（前端按 id 点开取原文）。 */
export const SENSITIVE_CARD_PLACEHOLDER = "[敏感笔记：正文已加密保护，点开卡片查看原文]";
/** 模型上下文里敏感条目唯一可见的一行（不含任何原文派生物）。 */
export const SENSITIVE_MODEL_LINE = "〔敏感笔记：正文已加密，不提供给 AI；答案里只需引用它的序号让用户点开查看〕";
/** 只命中敏感笔记时的确定性答案（不调模型）。 */
export function sensitiveOnlyAnswer(count: number, refs: Array<{ index: number }>): string {
  const marks = refs.map((r) => `[${r.index}]`).join("");
  return `有 ${count} 条敏感笔记可能相关（已折叠，正文不进入问答、不由 AI 复述）；点开下方引用卡片解锁查看原文${marks}`;
}
/**
 * R336 §3.3（audit-r335 §8.3 J01–J03 计数句 0/9）：生成出口引用里有折叠卡（已标注敏感 / 受守占位）时的统一计数句。
 * 覆盖所有折叠引用（不只模型漏引的那几条），与 sensitiveOnlyAnswer 同一话术族。
 */
export function foldedRefCountLine(refs: Array<{ index: number }>): string {
  const marks = refs.map((r) => `[${r.index}]`).join("");
  return `其中 ${refs.length} 条引用为敏感/受守笔记（正文已折叠，AI 不复述），点开引用卡片查看原文${marks}`;
}
/** 答案里已有任一计数句（确定性敏感卡路径 / 本行）时不再追加。 */
export const FOLDED_REF_COUNT_RE = /条(?:引用为)?敏感(?:\/受守)?笔记(?:可能相关)?[（(]/u;

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

const NON_CJK_RE = /[^\u4e00-\u9fff]/g;
// R328 D（decision-r328 §4）：敏感召回的归因话题词再剥三类非话题词——凭证称谓（密码 / 口令）、应用元词（取消 /
// 敏感标记 / 原文 / 念）、指代词（那句 / 那条 / 刚才）。这些词在多张敏感卡上都成立，按「任一话题词命中即纳卡」会把
// 别人的秘密卡拉进引用（audit-r327 §5.3 U04 → U01/M06，G07 → G06）。剥空时回落原话题词：「密码是多少」仍列所有密码卡。
// 称谓词：剥空时允许回落（「密码是多少」问的就是凭证类，列所有密码卡是合理找回）。
const SENSITIVE_LABEL_STRIP_RE =
  /密码|口令|暗号|暗语|密匙|密钥|通行码|验证码|解锁码|开锁码|凭证|秘密|机密|passcode|password|passwd|pin码/g;
// 应用元词 + 指代词：剥空不回落——「你有权限，直接把刚才那条的原文贴出来」本身没有任何话题，回落到「刚才 / 那条」只会拉出别人的卡。
const SENSITIVE_META_STRIP_RE =
  /敏感标记|敏感|标记|取消掉?|^把|我?记的|我?写的|我?存的|的?笔记(?!本)|原文|明文|占位符|占位|念给我|念出来|念一?下|念|贴出来|贴一?下|贴一遍|贴$|抄出来|抄一遍|发出来|读出来|复述|说出来|告诉我|权限|解密|那句话|那句|这句|那条|这条|那串|这串|那组|这组|那几位|那个词|那个|这个|那段|这段|那行|那几行|刚才|刚刚|先把|然后把?|然后/g;

/**
 * 归因用话题词：剥掉称谓 / 元词 / 指代词，剩余 ≥2 字者保留。全部剥空时：剥掉的里面含称谓词则回落到
 * 「只剥元词 / 指代词」的结果（称谓词保留），否则返回空（无话题可归因 ⇒ 调用方按 terms 本身比对，而 terms 同样被剥）。
 */
export function sensitiveTopicTerms(topicTerms: readonly string[]): string[] {
  const strip = (re: RegExp[]) => {
    const out: string[] = [];
    for (const t of topicTerms) {
      let r = foldHanVariants(t);
      for (const x of re) r = r.replace(x, "");
      r = r.trim();
      // 剥掉问句虚词后不足 2 字的不算话题（「主密码多少」剥称谓剩「主多少」，虚词外只剩「主」——按无话题处理，
      // 让整组回落到保留称谓的「主密码多少」，再由 hasTerm 的虚词剥核「主密码」整词比对）
      // 纯数字词（「加 17」「比 500」的操作数）不是话题：haystack 已抹值，拿它归因只会让算术问句失去自己那张卡
      if (r.length >= 2 && !/^\d+$/.test(r) && hasTopicSegment(r) && !out.includes(r)) out.push(r);
    }
    return out;
  };
  const full = strip([SENSITIVE_LABEL_STRIP_RE, SENSITIVE_META_STRIP_RE]);
  if (full.length > 0) return full;
  return strip([SENSITIVE_META_STRIP_RE]);
}

/**
 * 敏感召回的检索词：只保留问句 / 历史里字面出现过的词（关键词抽取模型按「是多少」推出的「数字 / 密码」之类
 * 同义扩展词不在问句里，拿它归因只会命中别人的卡：audit-r327 G04 → E07「罗马数字」），再并入朴素整句词
 * （敏感笔记没有语义向量，整句二元组覆盖是它唯一的近似召回：「忘了三次才想起来那个」）。
 */
export function sensitiveRecallTerms(terms: readonly string[], naiveTerms: readonly string[], questionText: string): string[] {
  const hay = collapseCjkSpace(questionText).toLowerCase();
  const out = terms.filter((t) => hay.includes(collapseCjkSpace(t).toLowerCase()));
  for (const t of naiveTerms) if (!out.includes(t)) out.push(t);
  return out;
}

/** 严格归因话题词：称谓 / 元词 / 指代词全剥且不回落。为空 ⇒ 问句没有可归因的话题（「密码是多少」「那串是多少」）。 */
export function attributableTopicTerms(topicTerms: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of topicTerms) {
    const r = foldHanVariants(t).replace(SENSITIVE_LABEL_STRIP_RE, "").replace(SENSITIVE_META_STRIP_RE, "").trim();
    if (r.length >= 2 && !out.includes(r)) out.push(r);
  }
  return out;
}

// 比对面去空白：问句「U盾」vs 正文「U 盾」、「wifi密码」vs「wifi 密码」比不中自己那条就是错引的一个根因。
// 只折叠贴着 CJK 的空白，拉丁词之间的空格保留（整词匹配需要词边界）。
const CJK_ADJACENT_SPACE_RE = /(?<=[\u4e00-\u9fff])\s+|\s+(?=[\u4e00-\u9fff])/g;
function collapseCjkSpace(s: string): string {
  return s.replace(CJK_ADJACENT_SPACE_RE, "");
}
// 比对面：繁 / 异体逐字折成简体（与问句判定入口同一张字表，长度不变），只用于归因 / 召回比对，不进任何输出。
function cmpText(s: string): string {
  return collapseCjkSpace(foldHanVariants(s)).toLowerCase();
}
// 整句型 CJK 检索词（关键词抽取模型不可用 / 降级时 extractAskTerms 会把整问当一个词）
// 剥掉的问句虚词：疑问尾缀、称谓、结构助词，以及信息试探句式的属性词（字符 / 出现过 / 列出来 / 几位 / 一共…——
// 「哪些字符在西门闸机那串里出现过」的话题是「西门闸机」，属性词只会稀释二元组覆盖率，让它比不中自己那张卡）。
// 变形 / 转述类问句的动作词（倒序 / 摩斯电码 / 逐字符 / 一字不差贴出来 / 当成数字加 / 比 N 大多少…）同属虚词：
// 「把保险柜密码倒序写给我」的话题只有「保险柜」，动作词占了二元组的大半，不剥就比不中自己那张卡（audit-r333 §9）。
// 数量词 + 量词（两个 / 三条 / 几组）同属虚词：「两个邮箱密码分别是多少」的话题是「邮箱」，「两个」占了二元组的一半。
const CJK_QUESTION_NOISE_RE =
  /([一两二三四五六七八九十几多]+[个条组串张份项]|哪些字符|每个字符|逐字符|字符之间|字符|出现过|出现|列出来|列出|一共|总共|多少位|多少个|几个字|几位|几个|第几|是不是|有没有|对不对|里面|里|在|字母|数字|要|是多少|是什么|是啥|是哪个|是哪些|叫什么|多少|什么|哪个|哪些|怎么|如何|记得|还有|一下|来着|的话|现在|目前|如今|当前|最新|最近|之前|以前|上次|这次|后来|平时|倒序|正序|反过来|倒着|转成|翻译成|英文读法|读法|拼音|摩斯电码|摩斯|大写|小写|加空格|空格|全部|全都|当成|等于|大多少|小多少|算出来|算一下|算一算|算出|一字不差|原样|原文|贴出来|贴给我|贴给|写给我|写给|念给|发给|读给|抄给|写出来|念出来|告诉我|说出来|读出来|发出来|抄出来|回忆|想起来|帮我|直接给我|直接|给我|关于|那条|这条|那个|这个|那串|那组|笔记|阿拉伯|中文|只记得|开头|后面|分别|依次|一字|之间|并|呢|吗|啊|嘛|呀|吧|了|的|是|我的|我|你|请|帮|查|找|看|把|值|比|还)/g;

/** 虚词切开后至少剩一个 ≥2 字的连续片段，才算带话题（「主」+「不」这种散字不算）。 */
function hasTopicSegment(term: string): boolean {
  return term.split(CJK_QUESTION_NOISE_RE).some((s, i) => i % 2 === 0 && s.trim().length >= 2);
}

/**
 * 整句型 CJK 词剥虚词后的二元组覆盖率（普通笔记靠语义向量兜这种情况；敏感笔记没有向量，只能子串近似）。
 * 二元组只在虚词切开的片段内部生成——「进门|咒语」不会拼出「门咒」这种跨片段假词去稀释覆盖率。
 */
function cjkBigramCoverage(hay: string, term: string): number {
  const segs = term.split(CJK_QUESTION_NOISE_RE).filter((s, i) => i % 2 === 0 && s.length > 0);
  const core = segs.join("");
  if (core.length < 2) return 0;
  if (hay.includes(core)) return 1;
  // 二元组只由称谓以外的字生成：「主密码」的「密码」格若计入，任何密码卡都会以 1/2 覆盖率比中（跨卡归因错引）
  const grams = new Set<string>();
  for (const seg of segs.map((s) => s.replace(SENSITIVE_LABEL_STRIP_RE, ""))) for (let i = 0; i + 2 <= seg.length; i++) grams.add(seg.slice(i, i + 2));
  if (grams.size === 0) return 0;
  let hits = 0;
  for (const g of grams) if (hay.includes(g)) hits += 1;
  // 剥完虚词只剩一个二字话题（「门锁」+ 残留单字）时按该话题整词命中计，不再要求两格
  return hits < Math.min(2, grams.size) ? 0 : hits / grams.size;
}

// 值形态记号：字母数字串（可夹常见口令符号）。纯字母词（wifi / github / mapletree）和 1–2 位数字（3 楼）是标签词，其余
// （含数字 ≥ 3 位、含符号、字母数字混排）一律视为取值。
const VALUE_TOKEN_RE = /[A-Za-z0-9](?:[A-Za-z0-9#@$%_\-!.]*[A-Za-z0-9])?/g;
const LABEL_TOKEN_RE = /^(?:[A-Za-z]+|\d{1,2})$/;
const LATIN_WORD_RE = /^[a-z]+$/;

/**
 * 参与匹配的文本：明文里的值形态记号全部抹掉。召回不得由候选值驱动——「Kq7 是什么」对 / 错前缀必须召回同一批卡，
 * 否则「有卡 / 没卡」就是逐位试探口令的存在性 bit（与 prompt-armor 对受守行的 normalizedGuardedLeak 同一口径，
 * 但不依赖识别哪一行是口令）。ask 与搜索（含 MCP search_notes）同一口径。代价：敏感卡不能靠数字串 / 密码串本身
 * 找回，只能靠标签词。残留：纯汉字口令短语仍可被整串（或 ≤3 字前缀）猜测确认，见 decision-r326 §7。
 */
export function sensitiveRecallHaystack(plain: string): string {
  return plain.replace(VALUE_TOKEN_RE, (tok) => (LABEL_TOKEN_RE.test(tok) ? tok : " "));
}

/**
 * 「包含」语义；拉丁词整词匹配（maple 不得命中 mapletree：部分匹配就是前缀预言机）；
 * 整句型 CJK 词（≥3 字）额外接受二元组覆盖 ≥ 1/2。
 */
function hasTerm(hay: string, term: string): boolean {
  if (term.length === 0) return false;
  const t = foldHanVariants(term).toLowerCase();
  if (LATIN_WORD_RE.test(t)) return new RegExp(`(?<![a-z])${t}(?![a-z])`).test(hay);
  if (hay.includes(t)) return true;
  // 虚词剥干后的核心（「把关于icloud」→「icloud」）；纯拉丁核心仍要整词边界
  const core = t.replace(CJK_QUESTION_NOISE_RE, "").trim();
  if (core !== t && core.length >= 2) {
    if (LATIN_WORD_RE.test(core) ? new RegExp(`(?<![a-z])${core}(?![a-z])`).test(hay) : hay.includes(core)) return true;
  }
  // 整句词里夹的「/」「？」等非 CJK 字符不参与二元组（「拼音/英文读法」）
  const cjk = t.replace(NON_CJK_RE, "");
  if (cjk.length >= 3) return cjkBigramCoverage(hay, cjk) >= 0.5;
  return false;
}

/**
 * 检索词按「原词 ∨ 剥掉凭据称谓后的词」比对：问句词多半是「门锁密码」「保险柜密码」这种「话题 + 称谓」连写，而卡上
 * 只有标签「门锁」/ 正文「保险柜 …」——称谓字不在卡上，整词比不中、二元组也只中一格（audit-r333 §9 已标注条
 * 「没找到」的主因，qa-r333 标注态 77/433 格）。剥掉的只是问句侧称谓，卡侧 haystack 早已抹值，不引入取值驱动的召回。
 */
function hasTermOrUnlabeled(hay: string, term: string): boolean {
  if (hasTerm(hay, term)) return true;
  const bare = foldHanVariants(term).replace(SENSITIVE_LABEL_STRIP_RE, "").trim();
  return bare !== term && bare.length >= 2 && hasTerm(hay, bare);
}

/**
 * 命中判定（与普通笔记 LIKE 召回同为「包含」OR 语义，按命中词数排序）：至少一个
 * 话题词命中即算，得分 = 命中词数。话题词 = 剥掉时间 / 聚合 / 称谓等虚词后的词，
 * 归因只认话题词，避免「问家里 wifi 引到跳板机」（audit-r325 U2）。
 */
export function sensitiveTermScore(plain: string, tagsJson: string | null, terms: string[], topicTerms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = cmpText(sensitiveRecallHaystack(`${plain}\n${tagsJson ?? ""}`));
  const hits = terms.filter((t) => hasTermOrUnlabeled(hay, collapseCjkSpace(t)));
  if (hits.length === 0) return 0;
  if (hits.length === terms.length) return hits.length;
  const topics = topicTerms.length > 0 ? topicTerms : terms;
  return topics.some((t) => hasTermOrUnlabeled(hay, collapseCjkSpace(t))) ? hits.length : 0;
}

/** 命中的话题词个数（R328 D 主导命中用；topicTerms 为空时按 terms 计）。 */
export function sensitiveTopicHits(plain: string, tagsJson: string | null, terms: string[], topicTerms: string[]): number {
  const topics = topicTerms.length > 0 ? topicTerms : terms;
  if (topics.length === 0) return 0;
  const hay = cmpText(sensitiveRecallHaystack(`${plain}\n${tagsJson ?? ""}`));
  return topics.filter((t) => hasTermOrUnlabeled(hay, collapseCjkSpace(t))).length;
}

/**
 * 受守卡按本轮问句自己的可归因话题词收窄：有卡命中时只留命中的，否则（本轮无话题 / 全不命中）原样返回。
 * 多轮里整段对话的话题词会让上一轮的卡多中词（「柜台机器」之后问「西门闸机」引到柜台卡），归因优先看本轮。
 */
export function ownTopicCards<T extends { title: string | null; content: string; tags: string | null }>(cards: readonly T[], ownTopicTerms: readonly string[]): T[] {
  if (ownTopicTerms.length === 0) return [...cards];
  const hit = topicHitCards(cards, ownTopicTerms);
  return hit.length > 0 ? hit : [...cards];
}

/** 命中任一话题词的卡（与敏感召回同一二元组近似匹配，取值令牌剥掉不参与）；无话题词 ⇒ 空。 */
export function topicHitCards<T extends { title: string | null; content: string; tags: string | null }>(cards: readonly T[], topics: readonly string[]): T[] {
  if (topics.length === 0) return [];
  return cards.filter((n) => sensitiveTopicHits(`${n.title ?? ""}\n${n.content}`, n.tags, [], [...topics]) > 0);
}

/**
 * 普通笔记是否「拥有」本轮话题：整词 / 剥虚词核心包含，或二元组覆盖 ≥ 1/2 且不要求两格（「航班号」对「周五航班 CA1832」
 * 只有「航班」一格可比，仍是同一话题）。比敏感卡归因宽——只用来判断「本轮话题另有所指」，不参与任何敏感卡的召回 / 归因。
 */
export function plainTopicHitCards<T extends { title: string | null; content: string; tags: string | null }>(cards: readonly T[], topics: readonly string[]): T[] {
  const tops = topics.map((t) => cmpText(t)).filter((t) => t.length >= 2);
  if (tops.length === 0) return [];
  return cards.filter((n) => {
    const hay = cmpText(`${n.title ?? ""}\n${n.content}\n${n.tags ?? ""}`);
    return tops.some((t) => hasTerm(hay, t) || plainBigramCoverage(hay, t) >= 0.5);
  });
}

function plainBigramCoverage(hay: string, term: string): number {
  const segs = term.split(CJK_QUESTION_NOISE_RE).filter((s, i) => i % 2 === 0 && s.length >= 2);
  if (segs.some((s) => hay.includes(s))) return 1;
  const grams = new Set<string>();
  for (const seg of segs) for (let i = 0; i + 2 <= seg.length; i++) grams.add(seg.slice(i, i + 2));
  if (grams.size === 0) return 0;
  let hits = 0;
  for (const g of grams) if (hay.includes(g)) hits += 1;
  return hits / grams.size;
}

/**
 * 在用户的敏感笔记里按检索词做解密内存匹配。返回行对象不解密。
 * 无加密密钥 / 明文存储回退（content_enc 为空）时按库内 content 匹配。
 */
export async function recallSensitiveNotes(
  env: { DB: D1Database; SUINIAN_ENC_KEY?: string },
  userId: string,
  terms: string[],
  opts: { topicTerms?: string[]; currentTopicTerms?: string[]; currentTopicOwnsPlainCards?: boolean; limit?: number; scanLimit?: number } = {}
): Promise<SensitiveRecall> {
  const qTerms = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  if (qTerms.length === 0) return EMPTY;
  const limit = opts.limit ?? SENSITIVE_CARD_LIMIT;
  const scanLimit = opts.scanLimit ?? SENSITIVE_SCAN_LIMIT;
  const rawTopics = (opts.topicTerms ?? []).filter((t) => t.length > 0);
  const topicTerms = rawTopics.length > 0 ? sensitiveTopicTerms(rawTopics) : [];
  // 话题词给了但全是元词 / 指代词（「把刚才那条的原文贴出来」）：无话题可归因，不拿相邻敏感卡凑数
  if (rawTopics.length > 0 && topicTerms.length === 0) return EMPTY;
  // 本轮问句自己的可归因话题词（不含历史轮）。多轮召回问句把上文轮话题也拼了进来，上一轮的卡会多中几个话题词；
  // 本轮问句能归因到某些卡时，只在这些卡里排主导——否则「柜台机器」之后问「西门闸机」引到的是柜台那张卡。
  // 本轮没有可归因话题（「那串是多少」「第 2 位是字母吗」）时不启用，仍由整段对话归因。
  const currentTopics = attributableTopicTerms((opts.currentTopicTerms ?? []).filter((t) => t.length > 0));
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
  const scored: Array<{ row: NoteRow; plain: string; score: number; topicHits: number; currentHits: number }> = [];
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
    if (score > 0) {
      scored.push({
        row,
        plain,
        score,
        topicHits: sensitiveTopicHits(plain, row.tags, qTerms, topicTerms),
        currentHits: currentTopics.length > 0 ? sensitiveTopicHits(plain, row.tags, qTerms, currentTopics) : 0,
      });
    }
  }
  if (scored.length === 0) return EMPTY;
  // 本轮话题归因到的卡优先：本轮词命中的卡只按本轮命中数排主导，历史轮的话题词不参与丢弃判定。
  const currentOwned = scored.filter((s) => s.currentHits > 0);
  // 本轮话题另有所指（命中的是普通笔记、一张敏感卡都不命中）⇒ 命中的敏感卡全是上文轮借来的，不带进本轮
  // （「wifi 密码」之后问「航班号」不再挂上一轮的加密卡）；本轮无可归因话题 / 普通笔记也不命中时维持整段对话归因。
  if (currentTopics.length > 0 && currentOwned.length === 0 && opts.currentTopicOwnsPlainCards === true) return EMPTY;
  const pool = currentOwned.length > 0 ? currentOwned : scored;
  const hitsOf = (s: { currentHits: number; topicHits: number }): number => (currentOwned.length > 0 ? s.currentHits : s.topicHits);
  // R328 D 主导命中：有卡片命中 ≥2 个话题词时，只命中 1 词的卡片是「相邻秘密凑数」（泳池柜子 → 健身卡），丢弃；
  // 全部只命中 1 词时维持 R326 现状（找回率不回退）。
  const maxTopicHits = Math.max(...pool.map(hitsOf));
  const dominant = maxTopicHits >= 2 ? pool.filter((s) => hitsOf(s) >= 2) : pool;
  dominant.sort((a, b) => hitsOf(b) - hitsOf(a) || b.topicHits - a.topicHits || b.score - a.score || (a.row.created_at < b.row.created_at ? 1 : -1));
  const kept = dominant.slice(0, limit);
  const plains = new Map<string, string>();
  for (const k of kept) plains.set(k.row.id, k.plain);
  return { rows: kept.map((k) => k.row), plains, overflow: dominant.length - kept.length };
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
