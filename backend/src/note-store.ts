// notes 内容字段的唯一持久层（R124 P1-1 结构性收口）：
// R117→R119→R121→R123 连续四轮同型缺陷（「另一个入口」绕过敏感管道）的根因是
// 每个入口各自手写 INSERT/UPDATE notes 的内容字段。本模块是全仓唯一允许出现
// 对 notes 内容字段（content / content_enc / title / tags / is_sensitive）
// INSERT/UPDATE SQL 的地方——敏感管道（sensitiveIngestGate / 元数据洗净 /
// raw_transcript 洗净）内嵌在这里，业务代码只能带明文进来，绕不开口径。
// 架构级单测 test/write-path-guard.test.ts 静态断言其余 src 文件不含此类 SQL。
import type { NoteMeta, TriageResult } from "./types";
import { sensitiveIngestGate, scrubDerivedMeta, DERIVED_PLAINTEXT_META_KEYS, type GatedNoteFields } from "./ingest";
import { sanitizeSensitiveTags } from "./triage";
import { syncAttachmentEncryption } from "./media";
import { encryptContent, decryptContent, contentFingerprint, ENC_PLACEHOLDER, IMPORT_FP_VERSION } from "./crypto";

export function parseNoteMeta(raw: string | null): NoteMeta | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as NoteMeta;
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
}

// 守护列：这些列的写入只能发生在本模块内（见 write-path-guard 单测）
const GUARDED_SET_RE = /(^|[^0-9A-Za-z_])(content|content_enc|title|tags|is_sensitive)\s*=/;

/** 调用方附带的非守护字段 SET 子句绝不允许夹带守护列（纵深防御）。 */
function assertUnguarded(sets: string[]): void {
  for (const s of sets) {
    if (GUARDED_SET_RE.test(s)) throw new Error(`note-store: guarded column in extra set: ${s}`);
  }
}

export interface NoteInsertFields {
  id: string;
  user_id: string;
  source: string;
  raw_type: string;
  content: string;
  url?: string | null;
  category?: string | null;
  tags: string[];
  title?: string | null;
  is_sensitive?: boolean;
  /** meta 对象，或基于管道结果延迟构造的回调（导入需按敏感与否决定 import_tags） */
  meta?: NoteMeta | null | ((gated: GatedNoteFields) => NoteMeta | null);
  url_title?: string | null;
  url_summary?: string | null;
  url_titles?: string | null;
  todo_due?: string | null;
  todo_done?: boolean;
  done_at?: string | null;
  amount?: number | null;
  currency?: string | null;
  /** 保留原始时间（导入/恢复）；缺省 datetime('now') */
  created_at?: string | null;
  updated_at?: string | null;
}

export interface NoteInsertOptions {
  /** 是否有模型复判跟进（同 sensitiveIngestGate 的 rejudge 语义） */
  rejudge: boolean;
  /**
   * is_sensitive 落库口径：
   * - "always"（导入/恢复）：预检命中即标敏感（无密钥时明文仍被标记隔离）；
   * - "onlyEncrypted"（速记 createNote 既有口径）：只有真正加密成功才标敏感，
   *   无密钥环境交由模型主判，避免疑似命中永久卡在无定论状态。
   */
  markSensitive?: "always" | "onlyEncrypted";
}

/**
 * 唯一的 notes 插入构造器：先过敏感管道，再产出可 batch 的预编译语句。
 * 敏感时 meta.raw_transcript 一并洗净；仅疑似命中时把 needs_retriage 记入 meta
 * 交 cron 复判。
 */
export async function prepareNoteInsert(
  env: { SUINIAN_ENC_KEY?: string },
  db: D1Database,
  f: NoteInsertFields,
  opts: NoteInsertOptions = { rejudge: true }
): Promise<{ stmt: D1PreparedStatement; gated: GatedNoteFields; storedSensitive: boolean }> {
  const gated = await sensitiveIngestGate(
    env,
    { content: f.content, title: f.title ?? null, tags: f.tags, is_sensitive: f.is_sensitive === true },
    { rejudge: opts.rejudge }
  );
  const storedSensitive =
    opts.markSensitive === "onlyEncrypted" ? gated.is_sensitive && gated.content_enc !== null : gated.is_sensitive;
  let meta: NoteMeta | null = (typeof f.meta === "function" ? f.meta(gated) : f.meta) ?? null;
  // 敏感落库：派生明文 meta（转写/图片描述/文件摘录/链接摘录）统一洗净
  if (storedSensitive) meta = scrubDerivedMeta(meta);
  // 敏感笔记落库后 content 只剩占位符：在唯一插入构造器里统一补内容指纹，
  // 导出后重新导入的去重才能覆盖 App 内直接创建的敏感笔记（导入路径
  // 已自带 import_fp，此处不覆盖）
  if (storedSensitive && f.content && (meta?.import_fp ?? undefined) === undefined) {
    meta = {
      ...(meta ?? {}),
      import_fp: await contentFingerprint(env.SUINIAN_ENC_KEY, f.content),
      import_fp_v: IMPORT_FP_VERSION,
    };
  }
  if (gated.needs_retriage) meta = { ...(meta ?? {}), needs_retriage: true };
  const stmt = db
    .prepare(
      `INSERT INTO notes (id, user_id, source, raw_type, content, url, url_title, url_summary, url_titles,
         category, tags, title, is_sensitive, content_enc, todo_due, todo_done, done_at, amount, currency,
         meta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`
    )
    .bind(
      f.id,
      f.user_id,
      f.source,
      f.raw_type,
      gated.content,
      f.url ?? null,
      // 链接派生明文（标题/AI 摘要）与 meta 派生字段同口径：敏感行不落明文
      storedSensitive ? null : (f.url_title ?? null),
      storedSensitive ? null : (f.url_summary ?? null),
      storedSensitive ? null : (f.url_titles ?? null),
      f.category ?? null,
      JSON.stringify(gated.tags),
      storedSensitive ? gated.title : (f.title ?? gated.title),
      storedSensitive ? 1 : 0,
      gated.content_enc,
      f.todo_due ?? null,
      f.todo_done ? 1 : 0,
      f.done_at ?? null,
      f.amount ?? null,
      f.currency ?? null,
      meta ? JSON.stringify(meta) : null,
      f.created_at ?? null,
      f.updated_at ?? null
    );
  return { stmt, gated, storedSensitive };
}

export interface ExistingNoteState {
  id: string;
  user_id: string;
  updated_at: string;
  is_sensitive: number;
  content: string;
  content_enc: string | null;
  tags: string;
  meta: string | null;
}

export interface NotePatchInput {
  content?: string;
  title?: string;
  tags?: string[];
  is_sensitive?: boolean;
  /** 调用方已合并好的 meta（manual_override 等）；给出即写入 */
  meta?: NoteMeta;
}

export interface NotePatchResult {
  changes: number;
  /** 落库后的敏感状态 */
  sensitive: boolean;
  /** 疑似命中（fail-closed 预检）待模型复判 */
  needsRetriage: boolean;
}

/**
 * 唯一的用户编辑（PATCH）执行器：内容/标题/标签/敏感位的任何组合修改都在
 * 这里统一过敏感口径——新内容即使调用方声明"非敏感"也要过 fail-closed 预检
 * （R123 P1：PATCH 曾绕过管道把秘密值明文落库），敏感目标态下 title 一律置空、
 * tags 严格过滤、meta.raw_transcript 洗净。CAS（updated_at）与调用方的
 * 非守护字段 SET 一并执行。
 */
export async function applyNotePatch(
  env: { SUINIAN_ENC_KEY?: string; MEDIA?: R2Bucket },
  db: D1Database,
  existing: ExistingNoteState,
  p: NotePatchInput,
  extra: { sets: string[]; binds: unknown[] } = { sets: [], binds: [] }
): Promise<NotePatchResult> {
  assertUnguarded(extra.sets);
  const sets: string[] = [];
  const binds: unknown[] = [];
  const wantSensitive = p.is_sensitive ?? !!existing.is_sensitive;
  let sensitive = !!existing.is_sensitive;
  let needsRetriage = false;
  let meta: NoteMeta | null = p.meta ?? null;
  let metaChanged = p.meta !== undefined;

  const existingTags = (): string[] => {
    try {
      return (JSON.parse(existing.tags || "[]") as unknown[]).filter((t): t is string => typeof t === "string");
    } catch {
      return [];
    }
  };

  if (typeof p.content === "string") {
    // 新内容统一过管道：显式敏感 or fail-closed 预检命中 → 加密落库
    const gated = await sensitiveIngestGate(
      env,
      { content: p.content, title: null, tags: [], is_sensitive: wantSensitive },
      { rejudge: true }
    );
    sensitive = gated.is_sensitive;
    needsRetriage = gated.needs_retriage;
    sets.push("content = ?", "content_enc = ?");
    binds.push(gated.content, gated.content_enc);
  } else if (typeof p.is_sensitive === "boolean" && p.is_sensitive !== !!existing.is_sensitive) {
    if (p.is_sensitive) {
      // 转敏感：现有明文就地加密
      sensitive = true;
      if (env.SUINIAN_ENC_KEY) {
        sets.push("content = ?", "content_enc = ?");
        binds.push(ENC_PLACEHOLDER, await encryptContent(env.SUINIAN_ENC_KEY, existing.content));
      }
    } else {
      // 解除敏感：从密文恢复明文（无法解密则保留现存内容）
      sensitive = false;
      const plain =
        existing.content_enc && env.SUINIAN_ENC_KEY
          ? await decryptContent(env.SUINIAN_ENC_KEY, existing.content_enc)
          : null;
      sets.push("content = ?", "content_enc = ?");
      binds.push(plain ?? existing.content, null);
    }
  } else if (typeof p.is_sensitive === "boolean") {
    sensitive = p.is_sensitive;
  }
  if (typeof p.is_sensitive === "boolean" || sensitive !== !!existing.is_sensitive) {
    sets.push("is_sensitive = ?");
    binds.push(sensitive ? 1 : 0);
  }

  // title / tags：敏感目标态下永不落明文（显式提供也一样洗）
  if (typeof p.title === "string") {
    sets.push("title = ?");
    binds.push(sensitive ? null : p.title);
  } else if (sensitive && !existing.is_sensitive) {
    sets.push("title = NULL");
  }
  if (Array.isArray(p.tags)) {
    sets.push("tags = ?");
    binds.push(JSON.stringify(sensitive ? sanitizeSensitiveTags(p.tags) : p.tags));
  } else if (sensitive && !existing.is_sensitive) {
    sets.push("tags = ?");
    binds.push(JSON.stringify(sanitizeSensitiveTags(existingTags())));
  }

  // 敏感目标态：meta 里的派生明文（转写/图片描述/文件摘录/链接摘录）一并洗净；
  // 疑似命中记 needs_retriage 交 cron 复判
  if (sensitive || needsRetriage) {
    const base = meta ?? parseNoteMeta(existing.meta) ?? {};
    let m: NoteMeta = base;
    if (sensitive) {
      const scrubbed = scrubDerivedMeta(m);
      if (scrubbed !== m) {
        m = scrubbed ?? {};
        metaChanged = true;
      }
    }
    if (needsRetriage && !m.needs_retriage) {
      m = { ...m, needs_retriage: true };
      metaChanged = true;
    }
    meta = m;
  }
  // 转敏感时链接派生明文列一并清空（url_title/url_summary 可能含正文摘要）
  if (sensitive && !existing.is_sensitive) {
    sets.push("url_title = NULL", "url_summary = NULL", "url_titles = NULL");
  }
  if (metaChanged && meta) {
    sets.push("meta = ?");
    binds.push(JSON.stringify(meta));
  }

  const allSets = [...sets, ...extra.sets];
  if (allSets.length === 0) return { changes: 0, sensitive, needsRetriage };
  allSets.push("updated_at = datetime('now')");
  const res = await db
    .prepare(`UPDATE notes SET ${allSets.join(", ")} WHERE id = ? AND user_id = ? AND updated_at = ?`)
    .bind(...binds, ...extra.binds, existing.id, existing.user_id, existing.updated_at)
    .run();
  const changes = res.meta.changes ?? 0;
  // 转敏感：该笔记名下的 R2 附件原件同口径加密（R154 P2-2）
  if (changes > 0 && sensitive && !existing.is_sensitive) {
    await syncAttachmentEncryption({ MEDIA: env.MEDIA, DB: db, SUINIAN_ENC_KEY: env.SUINIAN_ENC_KEY }, existing.id);
  }
  return { changes, sensitive, needsRetriage };
}

/**
 * 媒体重试（retry-media）唯一的内容替换入口：重提取文本过管道后整体替换，
 * category 归零交回异步分拣。
 */
export async function replaceNoteContent(
  env: { SUINIAN_ENC_KEY?: string; MEDIA?: R2Bucket },
  db: D1Database,
  noteId: string,
  content: string,
  meta: NoteMeta,
  // 提取器自带的敏感判定（如视觉模型看到图中凭证）：与文本预检同门进闸
  isSensitive = false
): Promise<{ storedContent: string; contentEnc: string | null; sensitive: boolean }> {
  const gated = await sensitiveIngestGate(env, { content, title: null, tags: [], is_sensitive: isSensitive }, { rejudge: true });
  const sensitive = gated.is_sensitive && gated.content_enc !== null;
  const newMeta: NoteMeta = { ...(sensitive ? (scrubDerivedMeta(meta) ?? {}) : meta) };
  if (gated.needs_retriage) newMeta.needs_retriage = true;
  await db
    .prepare(
      "UPDATE notes SET content = ?, content_enc = ?, is_sensitive = ?, category = NULL, meta = ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(gated.content, gated.content_enc, sensitive ? 1 : 0, JSON.stringify(newMeta), noteId)
    .run();
  if (sensitive) await syncAttachmentEncryption({ MEDIA: env.MEDIA, DB: db, SUINIAN_ENC_KEY: env.SUINIAN_ENC_KEY }, noteId);
  return { storedContent: gated.content, contentEnc: gated.content_enc, sensitive };
}

/**
 * 模型分拣结果落库（速记异步分拣 / cron 复判共用）。敏感判定为真时按统一口径
 * 加密内容、title 置空、tags 严格过滤、派生明文 meta 洗净；判非敏感时恢复
 * fail-closed 预检加密的明文。用户手动改过的字段（manual_override）不覆盖。
 *
 * 并发模型（R126 P0，落实 R125 D2）：分拣是基于分拣启动时快照的异步回写，
 * 用户可能在窗口期内已编辑笔记。回写前比对当前库内明文与分拣快照，并以
 * updated_at 做 CAS 条件更新：内容已变 / CAS 失败 → 不覆盖任何字段，只标
 * needs_retriage 交 cron 用新内容重新分拣。用户编辑永远赢。
 */
export async function applyTriage(
  env: { DB: D1Database; SUINIAN_ENC_KEY?: string; MEDIA?: R2Bucket },
  noteId: string,
  triage: TriageResult,
  content: string
): Promise<void> {
  // imported notes carry their original tags in meta.import_tags: keep them
  // first and union in the AI-suggested ones
  const row = await env.DB.prepare(
    "SELECT meta, todo_due, content, content_enc, updated_at FROM notes WHERE id = ?"
  )
    .bind(noteId)
    .first<{ meta: string | null; todo_due: string | null; content: string; content_enc: string | null; updated_at: string }>();
  if (!row) return;
  // 库内当前明文（预检加密的 pending 笔记存的是密文）与分拣快照比对
  let current = row.content;
  if (row.content_enc && env.SUINIAN_ENC_KEY) {
    const plain = await decryptContent(env.SUINIAN_ENC_KEY, row.content_enc);
    if (plain !== null) current = plain;
  }
  if (current !== content) {
    // 用户（或其它管道）已改过内容：这份分拣结果对应旧快照，丢弃并交
    // cron 用新内容重分拣（不碰 updated_at，不干扰请求侧 CAS）
    await markNeedsRetriage(env.DB, noteId);
    return;
  }
  const meta = parseNoteMeta(row.meta);
  // 图片凭证敏感位粘性（R188 P1-1）：视觉模型判定图中含机密值时，只看文本
  // 的分拣模型不能凭「正文无秘密值」推翻（值可能正好没被抽入正文，而原图
  // 里的秘密仍在附件里）：敏感位取两者并集，加密/洗净仍走下方统一管道
  if (meta?.vision_sensitive && !triage.is_sensitive) {
    triage = { ...triage, is_sensitive: true };
  }
  // 存疑转写禁强副作用（R218 P2-2，audit-r217 §3）：transcript_suspect 的语音
  // 内容本身不可信（噪音幻听可被纠错成看似正常的中文），分拣结果不得凭空产生
  // 待办与账目——todo 降级 idea、todo_due/amount/merchant 置空。用户编辑核对
  // （清 suspect 位并标 needs_retriage）或 retry-media 成功后恢复正常口径。
  if (meta?.transcript_suspect) {
    triage = {
      ...triage,
      category: triage.category === "todo" ? "idea" : triage.category,
      todo_due: null,
      amount: null,
      currency: null,
      merchant: null,
    };
  }
  const override = meta?.manual_override;
  const importTags = meta?.import_tags;
  const newMeta: NoteMeta = { ...(meta ?? {}) };
  let metaChanged = false;
  if (newMeta.needs_retriage) {
    delete newMeta.needs_retriage;
    metaChanged = true;
  }
  // 分拣成功即离开失败态（R170 P1-2）
  if (newMeta.triage_failed !== undefined || newMeta.retriage_attempts !== undefined) {
    delete newMeta.triage_failed;
    delete newMeta.retriage_attempts;
    metaChanged = true;
  }
  // 无问号疑问句（R172 D-2）：分拣判「像在提问」记 meta，前端渲染「去问 AI」
  // 轻量入口；重分拣改判时同步清掉，敏感笔记不提示（避免引导把秘密值发问答）
  const wantQuestion = triage.is_question === true && !triage.is_sensitive;
  if (wantQuestion !== (newMeta.is_question === true)) {
    if (wantQuestion) newMeta.is_question = true;
    else delete newMeta.is_question;
    metaChanged = true;
  }
  const mergedTags = Array.isArray(importTags)
    ? [...new Set([...importTags, ...triage.tags])].slice(0, 6)
    : triage.tags;
  // 敏感笔记派生字段与加密口径一致（R120 P1-1）：content 进 content_enc 后，
  // AI title 可能把秘密值原样带出（如「todo密码是xxx」），title 一律置空，
  // tags 走严格过滤只留纯主题词
  const tags = triage.is_sensitive ? sanitizeSensitiveTags(mergedTags) : mergedTags;
  // 派生明文 meta（转写/图片描述/文件摘录/链接摘录）敏感时一并洗掉
  if (triage.is_sensitive) {
    for (const k of DERIVED_PLAINTEXT_META_KEYS) {
      if (newMeta[k] !== undefined) {
        delete newMeta[k];
        metaChanged = true;
      }
    }
  }
  const sets = ["is_sensitive = ?"];
  const binds: unknown[] = [triage.is_sensitive ? 1 : 0];
  // fields the user set by hand stay untouched
  if (!override?.title) {
    sets.push("title = ?");
    binds.push(triage.is_sensitive ? null : triage.title || null);
  }
  if (!override?.todo_due) {
    // AI only fills a missing due; an already-set due is never cleared or replaced
    sets.push("todo_due = ?");
    binds.push(row?.todo_due ?? triage.todo_due ?? null);
  }
  if (!override?.category) {
    sets.push("category = ?", "amount = ?", "currency = ?");
    binds.push(triage.category, triage.amount ?? null, triage.currency ?? null);
    if (triage.merchant) {
      newMeta.finance_merchant = triage.merchant;
      metaChanged = true;
    }
  } else if (triage.amount != null) {
    // 分类被手改只锁分类本身；金额/币种/商家提取仍生效（仅补空，不覆盖已有值）
    sets.push("amount = coalesce(amount, ?)", "currency = coalesce(currency, ?)");
    binds.push(triage.amount, triage.currency ?? null);
    if (triage.merchant && !newMeta.finance_merchant) {
      newMeta.finance_merchant = triage.merchant;
      metaChanged = true;
    }
  }
  if (metaChanged) {
    sets.push("meta = ?");
    binds.push(JSON.stringify(newMeta));
  }
  if (!override?.tags) {
    sets.push("tags = ?");
    binds.push(JSON.stringify(tags));
  }
  if (triage.is_sensitive && env.SUINIAN_ENC_KEY) {
    // encrypt-at-rest: ciphertext into content_enc, plaintext replaced by a placeholder
    const enc = await encryptContent(env.SUINIAN_ENC_KEY, content);
    sets.push("content = ?", "content_enc = ?");
    binds.push(ENC_PLACEHOLDER, enc);
  } else if (!triage.is_sensitive) {
    // the fail-closed pre-check may have encrypted the pending note; the model
    // (primary judge) says non-sensitive → restore plaintext, drop ciphertext
    sets.push("content = ?", "content_enc = NULL");
    binds.push(content);
  }
  if (triage.is_sensitive) {
    // 敏感判定：链接派生明文列（标题/AI 摘要）同口径清空
    sets.push("url_title = NULL", "url_summary = NULL", "url_titles = NULL");
  }
  // CAS：只有当行仍是分拣启动时的版本才允许回写；窗口期内被并发写入
  // 抢先 → 放弃本次回写，标 needs_retriage 交 cron 重分拣
  const res = await env.DB.prepare(
    `UPDATE notes SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ? AND updated_at = ?`
  )
    .bind(...binds, noteId, row.updated_at)
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    await markNeedsRetriage(env.DB, noteId);
    return;
  }
  // 分拣判敏感：已落 R2 的附件原件（异步存档早于分拣结论的窗口）补加密
  if (triage.is_sensitive) await syncAttachmentEncryption(env, noteId);
}

/** 分拣回写被并发编辑抢先时的处置：只标复判位，cron 用新内容重分拣。 */
async function markNeedsRetriage(db: D1Database, noteId: string): Promise<void> {
  await db
    .prepare("UPDATE notes SET meta = json_set(coalesce(meta, '{}'), '$.needs_retriage', json('true')) WHERE id = ?")
    .bind(noteId)
    .run();
}

/** AI 重算标题的唯一落库口（敏感笔记 SQL 级兜底拒写，绝不带出秘密值）。 */
export async function setNoteAiTitle(db: D1Database, noteId: string, title: string): Promise<void> {
  await db.prepare("UPDATE notes SET title = ? WHERE id = ? AND is_sensitive = 0").bind(title, noteId).run();
}

/**
 * tags 更新的唯一语句构造器（批量打标/去标、标签重命名/删除、链接摘要
 * 建议标签合并共用）：敏感行的 tags 一律先过 sanitizeSensitiveTags。
 */
export function prepareTagsUpdate(
  db: D1Database,
  row: { id: string; user_id: string; is_sensitive: number | boolean },
  tags: string[],
  meta?: NoteMeta | null
): D1PreparedStatement {
  const stored = JSON.stringify(row.is_sensitive ? sanitizeSensitiveTags(tags) : tags);
  if (meta !== undefined) {
    return db
      .prepare("UPDATE notes SET tags = ?, meta = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .bind(stored, meta ? JSON.stringify(meta) : null, row.id, row.user_id);
  }
  return db
    .prepare("UPDATE notes SET tags = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(stored, row.id, row.user_id);
}
