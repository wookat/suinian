// Full backup export/import: a zip containing manifest.json + notes.json
// (all fields) + threads/reports + media/ (R2 originals), and the reverse
// restore path (dedup, media re-upload, background pipeline backfill).
import { Zip, ZipDeflate, ZipPassThrough, Unzip, UnzipInflate, strToU8, strFromU8 } from "fflate";
import type { Env, NoteMeta, NoteRow, ThreadRow, WeeklyReportRow } from "./types";
import { decryptContent, decryptBytes, isEncryptedAttachment, ENC_PLACEHOLDER } from "./crypto";
import { prepareNoteInsert } from "./note-store";
import { backfillEmbeddings } from "./semantic";
import { backfillGraphExtracts } from "./graph";
import { clusterNote, UNTITLED_THREAD } from "./threads";
import { SENSITIVE_EXPORT_PLACEHOLDER } from "./constants";
import { maybeSensitive } from "./triage";
import { scrubDerivedMeta } from "./ingest";
import { storeOriginal, type MediaType } from "./media";
import {
  noteContainsExecutableCommand,
  noteMetaExecFragment,
  broadFoldReason,
  foldSafeTitle,
  foldOutletWarnLine,
  closeAggregateVerbatim,
  OUTLET_GLOBAL_RISK_NOTICE,
  OUTLET_GLOBAL_RISK_HEADER,
  OUTLET_GLOBAL_RISK_HEADER_VALUE,
  type BroadFoldReason,
} from "./prompt-armor";
import { recordOutletFoldMarks, recordOutletVerbatimClosed } from "./guard-events";
import { rejudgeExecFragmentsBulk } from "./exec-fragments";

export const BACKUP_FORMAT = "suinian-backup";
export const BACKUP_VERSION = 1;

/** Restore upload cap: streaming unzip keeps memory per-file, so this is generous. */
export const MAX_RESTORE_BYTES = 200 * 1024 * 1024;
/** Per-media-entry cap inside a backup zip (ingest caps uploads at 10MB). */
const MAX_MEDIA_ENTRY_BYTES = 15 * 1024 * 1024;
/** Cap for media entries that appear before notes.json in a foreign zip. */
const MAX_PENDING_MEDIA_BYTES = 64 * 1024 * 1024;

interface AttachmentRow {
  id: string;
  note_id: string;
  r2_key: string;
  mime: string | null;
  size: number | null;
}

export interface BackupAttachment {
  /** Entry path inside the zip, e.g. media/<note_id>/0-voice.ogg */
  path: string;
  name: string;
  mime: string | null;
  size: number | null;
}

export interface BackupNote {
  id: string;
  source: string;
  raw_type: string;
  content: string;
  url: string | null;
  url_title: string | null;
  url_summary: string | null;
  url_titles: string | null;
  category: string | null;
  tags: string[];
  title: string | null;
  is_sensitive: boolean;
  todo_due: string | null;
  todo_done: boolean;
  done_at: string | null;
  amount: number | null;
  currency: string | null;
  meta: NoteMeta | null;
  thread_title: string | null;
  created_at: string;
  updated_at: string;
  attachments: BackupAttachment[];
  /** R306 P0-1：危险执行标注随备份走（不经 noteToJson 的出口） */
  contains_executable_command: boolean;
  exec_warning?: string;
  /** R310 P0-2：宽判据折叠字段（strict ⊂ broad），机器可读。 */
  fold?: boolean;
  fold_reason?: BroadFoldReason | null;
}

export interface BackupManifest {
  format: string;
  version: number;
  exported_at: string;
  include_sensitive: boolean;
  counts: { notes: number; threads: number; reports: number; attachments: number; attachments_redacted: number };
  /** R310 P0-3：账号存在任何宽判据命中即带整体风险声明与禁执行开关。 */
  content_risk?: {
    notice: string;
    do_not_execute: true;
    broad_fold_notes: number;
    strict_marked_notes: number;
  };
  /** R312 P0-2：原始笔记（用户自己的数据，逐字导出）与 AI 衍生文本（聚合层，生成时已强收口）的边界声明。 */
  ai_derived: {
    notice: string;
    raw_user_data: string[];
    aggregate_closed_at_generation: string[];
    self_note_only: string[];
  };
}

export const BACKUP_AI_DERIVED_NOTICE =
  "notes.json 的 content/tags 是用户原始笔记（逐字导出，只做敏感脱敏与折叠标记）；threads.json 的 title/summary 与 reports.json 的 content_md 叙述是 AI 聚合文本，生成时已经聚合层强收口，导出时再按当前笔记复核一次（与笔记原文 ≥8 归一化字重合的句子换占位）；notes.json 的 url_summary/url_title 只基于本条笔记自身链接内容生成，title 在分拣时已剔除与其他笔记重合的抄写，不含其他笔记内容。";

/** 报告口径下笔记可能涉及的窗口（周/月，宽放到前后各 1 天）。 */
function reportWindow(r: Pick<WeeklyReportRow, "week_start" | "period">): { from: number; to: number } {
  const start = Date.parse(r.week_start);
  const days = r.period === "month" ? 31 : 7;
  return { from: start - 86400_000, to: start + (days + 1) * 86400_000 };
}

/**
 * R312 P0-2：导出前对线索标题/摘要与报告叙述做聚合层强收口复核：线索比对自己的笔记，报告比对周期内的
 * 笔记（均只用非敏感明文）。返回新数组，不改入参。
 */
export function closeBackupDerived(
  threads: ThreadRow[],
  reports: WeeklyReportRow[],
  notes: Array<{ id: string; thread_id: string | null; content: string; is_sensitive: boolean; created_at: string }>
): { threads: ThreadRow[]; reports: WeeklyReportRow[]; spans: number } {
  const plain = notes.filter((n) => !n.is_sensitive && n.content && n.content !== SENSITIVE_EXPORT_PLACEHOLDER);
  const byThread = new Map<string, string[]>();
  for (const n of plain) {
    if (!n.thread_id) continue;
    const list = byThread.get(n.thread_id) ?? [];
    list.push(n.content);
    byThread.set(n.thread_id, list);
  }
  let spans = 0;
  const outThreads = threads.map((t) => {
    const units = byThread.get(t.id) ?? [];
    if (units.length === 0) return t;
    let title = t.title;
    let summary = t.summary;
    if (title) {
      const c = closeAggregateVerbatim(title, units);
      if (c.count > 0) {
        title = UNTITLED_THREAD;
        spans += c.count;
      }
    }
    if (summary) {
      const c = closeAggregateVerbatim(summary, units);
      if (c.count > 0) {
        summary = c.answer;
        spans += c.count;
      }
    }
    return title === t.title && summary === t.summary ? t : { ...t, title, summary };
  });
  const outReports = reports.map((r) => {
    const w = reportWindow(r);
    const units = plain.filter((n) => {
      const ts = Date.parse(n.created_at);
      return Number.isFinite(ts) && ts >= w.from && ts <= w.to;
    }).map((n) => n.content);
    if (units.length === 0 || !r.content_md) return r;
    const c = closeAggregateVerbatim(r.content_md, units);
    if (c.count === 0) return r;
    spans += c.count;
    return { ...r, content_md: c.answer };
  });
  return { threads: outThreads, reports: outReports, spans };
}

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function attachmentName(r2Key: string, idx: number): string {
  const base = (r2Key.split("/").pop() || "file").replace(/^\d+-/, "");
  return `${idx}-${base}`;
}

/**
 * Stream a full backup zip: JSON entries first (deflated), then each R2
 * original as a stored (pass-through) entry, chunk by chunk, so worker memory
 * stays bounded regardless of the user's total media size.
 */
export async function buildBackupZip(
  env: Env,
  userId: string,
  includeSensitive: boolean,
  waitUntil: (p: Promise<unknown>) => void
): Promise<Response> {
  const [notesR, threadsR, reportsR] = await Promise.all([
    env.DB.prepare("SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC").bind(userId).all<NoteRow>(),
    env.DB.prepare("SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC").bind(userId).all<ThreadRow>(),
    env.DB.prepare("SELECT * FROM weekly_reports WHERE user_id = ? ORDER BY week_start DESC")
      .bind(userId)
      .all<WeeklyReportRow>(),
  ]);
  const notes = notesR.results ?? [];
  const threads = threadsR.results ?? [];
  const reports = reportsR.results ?? [];
  const attsR = await env.DB.prepare(
    "SELECT a.* FROM attachments a JOIN notes n ON a.note_id = n.id WHERE n.user_id = ? ORDER BY a.rowid ASC"
  )
    .bind(userId)
    .all<AttachmentRow>();
  const attachments = attsR.results ?? [];
  const attsByNote = new Map<string, AttachmentRow[]>();
  for (const a of attachments) {
    const list = attsByNote.get(a.note_id) ?? [];
    list.push(a);
    attsByNote.set(a.note_id, list);
  }

  const threadTitle = new Map(threads.map((t) => [t.id, t.title]));
  const backupNotes: BackupNote[] = [];
  const mediaEntries: { path: string; r2_key: string }[] = [];
  let attachmentsRedacted = 0;
  let execMarked = 0;
  let broadMarked = 0;
  // every note goes into the backup, including ones still waiting for AI
  // triage (category stays null and gets sorted after restore). Fail-closed:
  // besides confirmed-sensitive notes, a redacted (default) backup also
  // redacts pending notes whose content merely hints at credentials — the
  // model hasn't judged them yet, so plaintext must not leave via this path
  // (covers writes that predate the write-time pre-check and imports)
  for (const n of notes) {
    let content = n.content;
    let title = n.title;
    let tags = safeParse<string[]>(n.tags) ?? [];
    let meta = safeParse<NoteMeta>(n.meta);
    let urlTitle = n.url_title;
    let urlSummary = n.url_summary;
    let urlTitles = n.url_titles;
    const pendingUncertain =
      !n.is_sensitive && !includeSensitive && n.category === null && maybeSensitive(n.content);
    let redacted = false;
    if (n.is_sensitive || pendingUncertain) {
      if (includeSensitive) {
        if (n.content_enc && env.SUINIAN_ENC_KEY) {
          const plain = await decryptContent(env.SUINIAN_ENC_KEY, n.content_enc);
          if (plain !== null) content = plain;
        }
      } else {
        // 脱敏备份覆盖派生明文闭包（R126 P1-1）：meta 里的转写/描述/摘录
        // 与 url_title/url_summary 一并不出境
        redacted = true;
        content = SENSITIVE_EXPORT_PLACEHOLDER;
        title = SENSITIVE_EXPORT_PLACEHOLDER;
        tags = [];
        meta = scrubDerivedMeta(meta);
        urlTitle = null;
        urlSummary = null;
        urlTitles = null;
      }
    }
    const noteAtts = attsByNote.get(n.id) ?? [];
    // 敏感闭包覆盖附件原件：敏感定义源往往就是附件本身（截图里的密码、
    // 文件里的凭据），脱敏备份不打包其 R2 原件，仅在 manifest 计数说明；
    // 勾选 include_sensitive 时才随明文一并导出
    let backupAtts: BackupAttachment[] = [];
    if (redacted) {
      attachmentsRedacted += noteAtts.length;
    } else {
      backupAtts = noteAtts.map((a, i) => {
        const name = attachmentName(a.r2_key, i);
        const path = `media/${n.id}/${name}`;
        mediaEntries.push({ path, r2_key: a.r2_key });
        return { path, name, mime: a.mime, size: a.size };
      });
    }
    const execFlag = !redacted && (noteContainsExecutableCommand(content) || noteMetaExecFragment(meta));
    // R310 P0-2：折叠以宽判据为准，严判据只决定警示强度
    const foldReason: BroadFoldReason | null = execFlag ? "strict" : redacted ? null : broadFoldReason(content);
    if (execFlag) execMarked++;
    if (foldReason !== null) {
      broadMarked++;
      title = foldSafeTitle(title, content, foldReason);
    }
    const warnLine = foldOutletWarnLine(foldReason);
    backupNotes.push({
      id: n.id,
      source: n.source,
      raw_type: n.raw_type,
      content,
      url: n.url,
      url_title: urlTitle,
      url_summary: urlSummary,
      url_titles: urlTitles,
      category: n.category,
      tags,
      title,
      is_sensitive: !!n.is_sensitive || pendingUncertain,
      todo_due: n.todo_due,
      todo_done: !!n.todo_done,
      done_at: n.done_at,
      amount: n.amount,
      currency: n.currency,
      meta,
      thread_title: n.thread_id ? (threadTitle.get(n.thread_id) ?? null) : null,
      created_at: n.created_at,
      updated_at: n.updated_at,
      attachments: backupAtts,
      contains_executable_command: execFlag,
      fold: foldReason !== null,
      fold_reason: foldReason,
      ...(warnLine ? { exec_warning: warnLine } : {}),
    });
  }
  recordOutletFoldMarks(env, "backup", { strict: execMarked, broad: broadMarked }, waitUntil);

  // R312 P0-2：threads/reports 是聚合层 AI 文本，生成时已强收口；导出时再按当前笔记明文复核一次，
  // 兜住 R312 之前生成、尚未重建的旧线索/旧报告。
  const threadIdOf = new Map(notes.map((n) => [n.id, n.thread_id]));
  const closed = closeBackupDerived(threads, reports, backupNotes.map((b) => ({ ...b, thread_id: threadIdOf.get(b.id) ?? null })));
  const closedThreads = closed.threads;
  const closedReports = closed.reports;
  if (closed.spans > 0) {
    const closedTitle = new Map(closedThreads.map((t) => [t.id, t.title]));
    for (const b of backupNotes) {
      const tid = threadIdOf.get(b.id);
      if (tid && closedTitle.has(tid)) b.thread_title = closedTitle.get(tid) ?? null;
    }
  }
  recordOutletVerbatimClosed(env, "backup", closed.spans, waitUntil);

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    include_sensitive: includeSensitive,
    counts: {
      notes: backupNotes.length,
      threads: threads.length,
      reports: reports.length,
      attachments: mediaEntries.length,
      attachments_redacted: attachmentsRedacted,
    },
    ...(broadMarked > 0
      ? {
          content_risk: {
            notice: OUTLET_GLOBAL_RISK_NOTICE,
            do_not_execute: true as const,
            broad_fold_notes: broadMarked,
            strict_marked_notes: execMarked,
          },
        }
      : {}),
    ai_derived: {
      notice: BACKUP_AI_DERIVED_NOTICE,
      raw_user_data: ["notes.json#content", "notes.json#tags", "media/"],
      aggregate_closed_at_generation: ["threads.json#title", "threads.json#summary", "reports.json#content_md"],
      self_note_only: ["notes.json#title", "notes.json#url_title", "notes.json#url_summary", "notes.json#url_titles"],
    },
  };

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let failed = false;
  const zip = new Zip((err, dat, final) => {
    if (failed) return;
    if (err) {
      failed = true;
      void writer.abort(err);
      return;
    }
    void writer.write(dat).catch(() => {
      failed = true;
    });
    if (final) void writer.close().catch(() => undefined);
  });

  const addJson = (name: string, obj: unknown) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(strToU8(JSON.stringify(obj, null, 1)), true);
  };

  const drive = async () => {
    try {
      addJson("manifest.json", manifest);
      if (manifest.content_risk) {
        // 打开 ZIP 的人（或代理）第一眼能看到的纯文本声明，不依赖解析 manifest
        const f = new ZipDeflate("README-CONTENT-RISK.txt", { level: 6 });
        zip.add(f);
        f.push(
          strToU8(
            `${manifest.content_risk.notice}\n\n宽判据折叠：${manifest.content_risk.broad_fold_notes} 条；严判据判危：${manifest.content_risk.strict_marked_notes} 条。\n逐条标记见 notes.json 的 fold / fold_reason / exec_warning 字段。\n`
          ),
          true
        );
      }
      addJson("notes.json", backupNotes);
      addJson("threads.json", closedThreads);
      addJson("reports.json", closedReports);
      for (const m of mediaEntries) {
        if (failed || !env.MEDIA) break;
        const obj = await env.MEDIA.get(m.r2_key);
        if (!obj) continue;
        // 敏感附件原件在 R2 为 AES-GCM 信封（R154 P2-2）：完整备份承诺的是
        // 可直接使用的明文原件，打包前解密；无法解密时跳过而非吐密文
        const chunks: Uint8Array[] = [];
        const reader = (obj.body as ReadableStream<Uint8Array>).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        let bytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.length;
        }
        if (isEncryptedAttachment(bytes)) {
          const plain = env.SUINIAN_ENC_KEY ? await decryptBytes(env.SUINIAN_ENC_KEY, bytes) : null;
          if (!plain) continue;
          bytes = new Uint8Array(plain);
        }
        const f = new ZipPassThrough(m.path);
        zip.add(f);
        await writer.ready;
        f.push(bytes, true);
      }
      zip.end();
    } catch (e) {
      failed = true;
      console.error("backup: zip stream failed", e);
      void writer.abort(e).catch(() => undefined);
    }
  };
  waitUntil(drive());

  const date = new Date().toISOString().slice(0, 10);
  return new Response(readable, {
    headers: {
      "Content-Type": "application/zip",
      // 明文包文件名带 -full 后缀，桌面上与脱敏包肉眼可分
      "Content-Disposition": `attachment; filename="suinian-backup-${date}${includeSensitive ? "-full" : ""}.zip"`,
      "Cache-Control": "private, no-store",
      ...(manifest.content_risk ? { [OUTLET_GLOBAL_RISK_HEADER]: OUTLET_GLOBAL_RISK_HEADER_VALUE } : {}),
    },
  });
}

// ---- restore ----

export interface RestoreStats {
  notes_total: number;
  notes_imported: number;
  notes_skipped: number;
  /** 脱敏备份里的「[已加密内容]」占位壳：无明文可恢复，跳过不导入（R112 P2-2） */
  sensitive_skipped: number;
  /** 备份里的历史周报/月报（reports.json）导入条数（R194 P2-1） */
  reports_imported: number;
  /** 同周期已存在或字段无效而跳过的报告条数 */
  reports_skipped: number;
  /** 备份里的线索条数：线索是笔记的派生归组（新笔记 id 已变），不直接导入，
   * 由后台聚类重建；显式上报而非静默丢弃（R194 P2-1） */
  threads_rebuilt: number;
  media_imported: number;
  media_skipped: number;
  /** 单个文件超过大小上限，主动跳过未导入（区别于真正的导入失败） */
  media_oversized: number;
  media_failed: number;
}

function sanitizeMetaForRestore(meta: NoteMeta | null): NoteMeta | null {
  if (!meta) return null;
  // strip pipeline markers so the cron backfills re-run graph extraction
  const { graph_extracted_at: _g, ...rest } = meta as NoteMeta & { graph_extracted_at?: string };
  return Object.keys(rest).length > 0 ? rest : null;
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function validNote(raw: unknown): raw is BackupNote {
  if (typeof raw !== "object" || raw === null) return false;
  const n = raw as Record<string, unknown>;
  return (
    typeof n.content === "string" &&
    n.content.length > 0 &&
    typeof n.created_at === "string" &&
    DATETIME_RE.test(n.created_at)
  );
}

function concat(bufs: Uint8Array[]): Uint8Array {
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Restore a backup zip: insert notes (preserving created time / tags /
 * category / finance fields), re-upload media into R2 keyed by the new note
 * ids, and skip duplicates (same content + created_at). Embeddings / graph /
 * clustering are re-built by the existing cron backfills.
 */
export async function restoreBackup(
  env: Env,
  userId: string,
  stream: ReadableStream<Uint8Array>,
  waitUntil: (p: Promise<unknown>) => void
): Promise<RestoreStats | { error: string; status: 400 | 413 }> {
  const stats: RestoreStats = {
    notes_total: 0,
    notes_imported: 0,
    notes_skipped: 0,
    sensitive_skipped: 0,
    reports_imported: 0,
    reports_skipped: 0,
    threads_rebuilt: 0,
    media_imported: 0,
    media_skipped: 0,
    media_oversized: 0,
    media_failed: 0,
  };

  // old note id -> new note id (only for imported, non-duplicate notes)
  const idMap = new Map<string, string>();
  // 落库为敏感的新笔记 id：其媒体原件重上传时同口径加密（R154 P2-2）
  // restored idea notes get a first clustering pass in the background
  const ideaIds: string[] = [];
  // zip path -> attachment info from notes.json
  const attByPath = new Map<string, { oldNoteId: string; att: BackupAttachment }>();
  let notesSeen = false;
  let unzipError: string | null = null;
  const completed: ZipEntry[] = [];
  const pendingMedia: ZipEntry[] = [];
  let pendingBytes = 0;

  const unzip = new Unzip((file) => {
    const name = file.name;
    const isNotes = name === "notes.json";
    const isMedia = name.startsWith("media/");
    if (!isNotes && !isMedia && name !== "reports.json" && name !== "threads.json") return;
    if (isMedia && file.originalSize !== undefined && file.originalSize > MAX_MEDIA_ENTRY_BYTES) {
      stats.media_oversized++;
      return;
    }
    const bufs: Uint8Array[] = [];
    let size = 0;
    file.ondata = (err, dat, final) => {
      if (err) {
        unzipError = `备份文件损坏（${name} 解压失败）`;
        return;
      }
      size += dat.length;
      if (isMedia && size > MAX_MEDIA_ENTRY_BYTES) {
        // oversized single media: drop it, keep going
        stats.media_oversized++;
        file.terminate();
        return;
      }
      bufs.push(dat);
      if (final) completed.push({ name, data: concat(bufs) });
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  const processNotes = async (data: Uint8Array): Promise<{ error: string; status: 400 } | null> => {
    const parsed = safeParse<unknown>(strFromU8(data));
    if (!Array.isArray(parsed)) return { error: "备份包里的 notes.json 不是有效的笔记列表", status: 400 };
    const rawNotes = parsed.filter(validNote);
    stats.notes_total = rawNotes.length;
    const CHUNK = 40;
    for (let i = 0; i < rawNotes.length; i += CHUNK) {
      const chunk = rawNotes.slice(i, i + CHUNK);
      const ph = chunk.map(() => "?").join(",");
      const existing = await env.DB.prepare(
        `SELECT content, created_at FROM notes WHERE user_id = ? AND deleted_at IS NULL AND content IN (${ph})`
      )
        .bind(userId, ...chunk.map((n) => n.content))
        .all<{ content: string; created_at: string }>();
      const seen = new Set((existing.results ?? []).map((r) => `${r.created_at}\u0000${r.content}`));
      // sensitive notes are stored with a placeholder content + content_enc, so the
      // plaintext-content match above never hits them: dedup those by created_at,
      // comparing the decrypted content_enc when possible
      const sensIncoming = chunk.filter((n) => n.is_sensitive === true);
      const sensByTime = new Map<string, { content: string; content_enc: string | null }[]>();
      if (sensIncoming.length > 0) {
        const ph2 = sensIncoming.map(() => "?").join(",");
        const sensExisting = await env.DB.prepare(
          `SELECT content, content_enc, created_at FROM notes WHERE user_id = ? AND deleted_at IS NULL AND is_sensitive = 1 AND created_at IN (${ph2})`
        )
          .bind(userId, ...sensIncoming.map((n) => n.created_at))
          .all<{ content: string; content_enc: string | null; created_at: string }>();
        for (const r of sensExisting.results ?? []) {
          const list = sensByTime.get(r.created_at) ?? [];
          list.push(r);
          sensByTime.set(r.created_at, list);
        }
      }
      const isSensitiveDup = async (n: BackupNote): Promise<boolean> => {
        for (const r of sensByTime.get(n.created_at) ?? []) {
          if (r.content === n.content) return true; // redacted placeholder round-trip
          if (r.content_enc && env.SUINIAN_ENC_KEY) {
            const plain = await decryptContent(env.SUINIAN_ENC_KEY, r.content_enc);
            if (plain === null || plain === n.content) return true;
          } else if (r.content === ENC_PLACEHOLDER || r.content === SENSITIVE_EXPORT_PLACEHOLDER) {
            // existing row's plaintext is unrecoverable: same second + sensitive = duplicate
            return true;
          }
        }
        return false;
      };
      const stmts: D1PreparedStatement[] = [];
      for (const n of chunk) {
        // 脱敏备份的敏感笔记只剩占位符，无任何可恢复明文：静默导入会变成
        // 永久丢失明文的壳笔记，改为跳过并在统计里显式报告 sensitive_skipped，
        // 提醒用户迁移请用勾选敏感内容的完整备份
        if (n.is_sensitive === true && (n.content === SENSITIVE_EXPORT_PLACEHOLDER || n.content === ENC_PLACEHOLDER)) {
          stats.sensitive_skipped++;
          continue;
        }
        const key = `${n.created_at}\u0000${n.content}`;
        if (seen.has(key) || (n.is_sensitive === true && (await isSensitiveDup(n)))) {
          stats.notes_skipped++;
          continue;
        }
        seen.add(key);
        if (n.is_sensitive === true) {
          const list = sensByTime.get(n.created_at) ?? [];
          list.push({ content: n.content, content_enc: null });
          sensByTime.set(n.created_at, list);
        }
        const newId = crypto.randomUUID();
        if (typeof n.id === "string") idMap.set(n.id, newId);
        if (n.category === "idea") ideaIds.push(newId);
        for (const a of n.attachments ?? []) {
          if (a && typeof a.path === "string") attByPath.set(a.path, { oldNoteId: n.id, att: a });
        }
        // 恢复入库走持久层统一敏感管道（R122 P1-1 / R124 P1-1 收口）：不再信任
        // 备份文件里的 is_sensitive 定论——外来/篡改的 zip 可以带着明文密码 +
        // is_sensitive:false + 既定 category 绕过整个敏感体系。
        const { stmt } = await prepareNoteInsert(env, env.DB, {
          id: newId,
          user_id: userId,
          source: typeof n.source === "string" ? n.source : "import",
          raw_type: typeof n.raw_type === "string" ? n.raw_type : "text",
          content: n.content,
          url: typeof n.url === "string" ? n.url : null,
          url_title: typeof n.url_title === "string" ? n.url_title : null,
          url_summary: typeof n.url_summary === "string" ? n.url_summary : null,
          url_titles: typeof n.url_titles === "string" ? n.url_titles : null,
          category: typeof n.category === "string" ? n.category : null,
          tags: Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string").slice(0, 6) : [],
          title: typeof n.title === "string" ? n.title : null,
          is_sensitive: n.is_sensitive === true,
          todo_due: typeof n.todo_due === "string" ? n.todo_due : null,
          todo_done: n.todo_done === true,
          done_at: typeof n.done_at === "string" ? n.done_at : null,
          amount: typeof n.amount === "number" ? n.amount : null,
          currency: typeof n.currency === "string" ? n.currency : null,
          meta: sanitizeMetaForRestore(typeof n.meta === "object" ? n.meta : null),
          created_at: n.created_at,
          updated_at: DATETIME_RE.test(n.updated_at ?? "") ? n.updated_at : n.created_at,
        });
        stmts.push(stmt);
      }
      if (stmts.length > 0) await env.DB.batch(stmts);
      stats.notes_imported += stmts.length;
    }
    return null;
  };

  // 历史周报/月报是用户可见的成品（过去周期不会重新生成），恢复时直接导入；
  // 同周期（week_start + period）已有报告时跳过，重复恢复幂等（R194 P2-1）
  const processReports = async (data: Uint8Array): Promise<void> => {
    const parsed = safeParse<unknown>(strFromU8(data));
    if (!Array.isArray(parsed)) return;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    for (const raw of parsed) {
      const r = raw as Record<string, unknown>;
      const weekStart = typeof r?.week_start === "string" && DATE_RE.test(r.week_start) ? r.week_start : null;
      const period = r?.period === "month" ? "month" : r?.period === "week" || r?.period === undefined ? "week" : null;
      const md = typeof r?.content_md === "string" && r.content_md.length > 0 ? r.content_md : null;
      if (!weekStart || !period || !md) {
        stats.reports_skipped++;
        continue;
      }
      const existing = await env.DB.prepare(
        "SELECT id FROM weekly_reports WHERE user_id = ? AND week_start = ? AND period = ?"
      )
        .bind(userId, weekStart, period)
        .first<{ id: string }>();
      if (existing) {
        stats.reports_skipped++;
        continue;
      }
      await env.DB.prepare(
        "INSERT INTO weekly_reports (id, user_id, week_start, period, content_md) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(crypto.randomUUID(), userId, weekStart, period, md.slice(0, 100_000))
        .run();
      stats.reports_imported++;
    }
  };

  const storeMedia = async (entry: ZipEntry): Promise<void> => {
    // 每个被跳过的媒体只在这里计一次（R118 P2：笔记循环不再预计，
    // 避免重复恢复时 media_skipped 翻倍）：父笔记被跳过/重复的媒体没有
    // attByPath 映射或没有新 ID，都落到下面两个分支
    const info = attByPath.get(entry.name);
    if (!info) {
      stats.media_skipped++;
      return;
    }
    const newNoteId = idMap.get(info.oldNoteId);
    if (!newNoteId) {
      stats.media_skipped++;
      return;
    }
    if (!env.MEDIA) {
      stats.media_failed++;
      return;
    }
    // 恢复路径统一走 storeOriginal 入库管道（mime 兜底、敏感加密信封均在边界内）
    const mime = info.att.mime || "";
    const type: MediaType = mime.startsWith("audio/") ? "audio" : mime.startsWith("image/") ? "image" : "file";
    const key = await storeOriginal(env, userId, newNoteId, {
      type,
      bytes: entry.data,
      mime,
      fileName: info.att.name,
    });
    if (key) stats.media_imported++;
    else stats.media_failed++;
  };

  const drain = async (): Promise<{ error: string; status: 400 | 413 } | null> => {
    while (completed.length > 0) {
      const entry = completed.shift()!;
      if (entry.name === "notes.json") {
        notesSeen = true;
        const err = await processNotes(entry.data);
        if (err) return err;
        // media that arrived before notes.json (foreign zip ordering)
        while (pendingMedia.length > 0) await storeMedia(pendingMedia.shift()!);
        pendingBytes = 0;
      } else if (entry.name === "reports.json") {
        await processReports(entry.data);
      } else if (entry.name === "threads.json") {
        // 线索行指向旧笔记 id，恢复后 id 全部重发，直接导入只会产生孤儿组；
        // 计数上报「将由后台聚类重建」，不再静默丢弃
        const parsed = safeParse<unknown>(strFromU8(entry.data));
        if (Array.isArray(parsed)) stats.threads_rebuilt = parsed.length;
      } else if (!notesSeen) {
        pendingBytes += entry.data.length;
        if (pendingBytes > MAX_PENDING_MEDIA_BYTES) {
          return { error: "备份包过大或格式异常（notes.json 之前的媒体太多）", status: 413 };
        }
        pendingMedia.push(entry);
      } else {
        await storeMedia(entry);
      }
    }
    return null;
  };

  const reader = stream.getReader();
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        unzip.push(new Uint8Array(0), true);
        break;
      }
      totalBytes += value.length;
      if (totalBytes > MAX_RESTORE_BYTES) {
        return { error: `备份文件过大：最大支持 ${MAX_RESTORE_BYTES / 1024 / 1024}MB`, status: 413 };
      }
      unzip.push(value);
      if (unzipError) return { error: unzipError, status: 400 };
      const err = await drain();
      if (err) return err;
    }
  } catch (e) {
    console.error("restore: unzip failed", e);
    return { error: "无法解析备份文件，请确认是碎念导出的完整备份 zip", status: 400 };
  }
  if (unzipError) return { error: unzipError, status: 400 };
  const err = await drain();
  if (err) return err;
  if (!notesSeen) return { error: "备份包里没有 notes.json，请确认是碎念导出的完整备份 zip", status: 400 };

  // kick the pipeline for a first batch right away; the 10-minute cron
  // backfills (embeddings / graph / link extracts) cover the rest gradually
  // R308 P0-1：恢复的笔记保留原始时间，按新 id 集合做分片拼接复判（返回前完成，恢复后的列表已带标）
  await rejudgeExecFragmentsBulk(env, [...idMap.values()], waitUntil);
  waitUntil(
    (async () => {
      await backfillEmbeddings(env).catch(() => 0);
      await backfillGraphExtracts(env).catch(() => 0);
      for (const id of ideaIds.slice(0, 30)) {
        const n = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
        if (n) await clusterNote(env, n).catch(() => undefined);
      }
    })()
  );
  return stats;
}
