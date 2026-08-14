// Full backup export/import: a zip containing manifest.json + notes.json
// (all fields) + threads/reports + media/ (R2 originals), and the reverse
// restore path (dedup, media re-upload, background pipeline backfill).
import { Zip, ZipDeflate, ZipPassThrough, Unzip, UnzipInflate, strToU8, strFromU8 } from "fflate";
import type { Env, NoteMeta, NoteRow, ThreadRow, WeeklyReportRow } from "./types";
import { decryptContent, ENC_PLACEHOLDER } from "./crypto";
import { sensitiveIngestGate } from "./ingest";
import { backfillEmbeddings } from "./semantic";
import { backfillGraphExtracts } from "./graph";
import { clusterNote } from "./threads";
import { SENSITIVE_EXPORT_PLACEHOLDER } from "./constants";
import { maybeSensitive } from "./triage";

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
}

export interface BackupManifest {
  format: string;
  version: number;
  exported_at: string;
  include_sensitive: boolean;
  counts: { notes: number; threads: number; reports: number; attachments: number };
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
    const pendingUncertain =
      !n.is_sensitive && !includeSensitive && n.category === null && maybeSensitive(n.content);
    if (n.is_sensitive || pendingUncertain) {
      if (includeSensitive) {
        if (n.content_enc && env.SUINIAN_ENC_KEY) {
          const plain = await decryptContent(env.SUINIAN_ENC_KEY, n.content_enc);
          if (plain !== null) content = plain;
        }
      } else {
        content = SENSITIVE_EXPORT_PLACEHOLDER;
        title = SENSITIVE_EXPORT_PLACEHOLDER;
        tags = [];
      }
    }
    const noteAtts = attsByNote.get(n.id) ?? [];
    const backupAtts: BackupAttachment[] = noteAtts.map((a, i) => {
      const name = attachmentName(a.r2_key, i);
      const path = `media/${n.id}/${name}`;
      mediaEntries.push({ path, r2_key: a.r2_key });
      return { path, name, mime: a.mime, size: a.size };
    });
    backupNotes.push({
      id: n.id,
      source: n.source,
      raw_type: n.raw_type,
      content,
      url: n.url,
      url_title: n.url_title,
      url_summary: n.url_summary,
      url_titles: n.url_titles,
      category: n.category,
      tags,
      title,
      is_sensitive: !!n.is_sensitive || pendingUncertain,
      todo_due: n.todo_due,
      todo_done: !!n.todo_done,
      done_at: n.done_at,
      amount: n.amount,
      currency: n.currency,
      meta: safeParse<NoteMeta>(n.meta),
      thread_title: n.thread_id ? (threadTitle.get(n.thread_id) ?? null) : null,
      created_at: n.created_at,
      updated_at: n.updated_at,
      attachments: backupAtts,
    });
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    include_sensitive: includeSensitive,
    counts: { notes: backupNotes.length, threads: threads.length, reports: reports.length, attachments: mediaEntries.length },
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
      addJson("notes.json", backupNotes);
      addJson("threads.json", threads);
      addJson("reports.json", reports);
      for (const m of mediaEntries) {
        if (failed || !env.MEDIA) break;
        const obj = await env.MEDIA.get(m.r2_key);
        if (!obj) continue;
        const f = new ZipPassThrough(m.path);
        zip.add(f);
        const reader = (obj.body as ReadableStream<Uint8Array>).getReader();
        let prev: Uint8Array | null = null;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (prev) {
            await writer.ready;
            f.push(prev);
          }
          prev = value;
        }
        f.push(prev ?? new Uint8Array(0), true);
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
      "Content-Disposition": `attachment; filename="suinian-backup-${date}.zip"`,
      "Cache-Control": "private, no-store",
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
    media_imported: 0,
    media_skipped: 0,
    media_oversized: 0,
    media_failed: 0,
  };

  // old note id -> new note id (only for imported, non-duplicate notes)
  const idMap = new Map<string, string>();
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
    if (!isNotes && !isMedia) return;
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
      const insert = env.DB.prepare(
        `INSERT INTO notes (id, user_id, source, raw_type, content, url, url_title, url_summary, url_titles,
           category, tags, title, is_sensitive, content_enc, todo_due, todo_done, done_at, amount, currency,
           meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
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
        // 恢复入库与其它入口走同一敏感管道（R122 P1-1）：不再信任备份文件里的
        // is_sensitive 定论——外来/篡改的 zip 可以带着明文密码 + is_sensitive:false
        // + 既定 category 绕过整个敏感体系。疑似命中标 needs_retriage 交 cron 复判。
        const gated = await sensitiveIngestGate(env, {
          content: n.content,
          title: typeof n.title === "string" ? n.title : null,
          tags: Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string").slice(0, 6) : [],
          is_sensitive: n.is_sensitive === true,
        });
        const { content, content_enc: contentEnc } = gated;
        const meta0 = sanitizeMetaForRestore(typeof n.meta === "object" ? n.meta : null);
        const meta = gated.needs_retriage ? { ...(meta0 ?? {}), needs_retriage: true } : meta0;
        stmts.push(
          insert.bind(
            newId,
            userId,
            typeof n.source === "string" ? n.source : "import",
            typeof n.raw_type === "string" ? n.raw_type : "text",
            content,
            typeof n.url === "string" ? n.url : null,
            typeof n.url_title === "string" ? n.url_title : null,
            typeof n.url_summary === "string" ? n.url_summary : null,
            typeof n.url_titles === "string" ? n.url_titles : null,
            typeof n.category === "string" ? n.category : null,
            JSON.stringify(gated.tags),
            gated.title,
            gated.is_sensitive ? 1 : 0,
            contentEnc,
            typeof n.todo_due === "string" ? n.todo_due : null,
            n.todo_done === true ? 1 : 0,
            typeof n.done_at === "string" ? n.done_at : null,
            typeof n.amount === "number" ? n.amount : null,
            typeof n.currency === "string" ? n.currency : null,
            meta ? JSON.stringify(meta) : null,
            n.created_at,
            DATETIME_RE.test(n.updated_at ?? "") ? n.updated_at : n.created_at
          )
        );
      }
      if (stmts.length > 0) await env.DB.batch(stmts);
      stats.notes_imported += stmts.length;
    }
    return null;
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
    const safeName = info.att.name.replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
    const key = `media/${userId}/${newNoteId}/${Date.now()}-${safeName}`;
    try {
      await env.MEDIA.put(key, entry.data, {
        httpMetadata: { contentType: info.att.mime ?? "application/octet-stream" },
      });
      await env.DB.prepare("INSERT INTO attachments (id, note_id, r2_key, mime, size) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), newNoteId, key, info.att.mime, entry.data.length)
        .run();
      stats.media_imported++;
    } catch (e) {
      console.error("restore: media upload failed", e);
      stats.media_failed++;
    }
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
