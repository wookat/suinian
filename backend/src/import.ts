// Import pipeline: parse Cubox / flomo / Markdown / plain-text export files
// into normalized note items (content + original created time + tags + url).

export interface ImportAsset {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface ImportItem {
  content: string;
  /** UTC "YYYY-MM-DD HH:MM:SS" (D1 datetime format); null = use now. */
  created_at: string | null;
  tags: string[];
  url: string | null;
  /** Image assets referenced by this note (zip imports), stored in R2. */
  assets?: ImportAsset[];
}

export interface ImportFailure {
  /** Short identifier for the failed entry (file name or content head). */
  item: string;
  reason: string;
}

export type ImportSource = "cubox" | "flomo" | "markdown" | "text" | "notion" | "obsidian" | "apple-notes";

export const IMPORT_SOURCES: ImportSource[] = ["cubox", "flomo", "markdown", "text", "notion", "obsidian", "apple-notes"];

/** Zip-based sources parsed by import-zip.ts. */
export const ZIP_IMPORT_SOURCES: ImportSource[] = ["notion", "obsidian", "apple-notes"];

export const MAX_IMPORT_ITEMS = 2000;
const MAX_ITEMS = MAX_IMPORT_ITEMS;
const MAX_ITEM_CHARS = 20_000;

// ---- shared helpers ----

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

/** Strip HTML into plain text, keeping block boundaries as newlines. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const pad = (n: number) => String(n).padStart(2, "0");

function toUtcSql(d: Date): string | null {
  if (isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/**
 * Normalize an export timestamp to UTC "YYYY-MM-DD HH:MM:SS".
 * Bare local datetimes (no zone info) are assumed to be Asia/Shanghai (+08:00),
 * matching Cubox / flomo exports for their (Chinese) user base.
 */
export function normalizeImportDate(raw: string | number | null | undefined): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    // unix epoch (seconds or milliseconds)
    const ms = raw > 1e12 ? raw : raw * 1000;
    return toUtcSql(new Date(ms));
  }
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{10}(\d{3})?$/.test(s)) return normalizeImportDate(parseInt(s, 10));
  // English wall-clock dates (Notion properties): "June 1, 2023 8:30 AM"
  const en = s.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?$/i
  );
  if (en) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const mo = months.indexOf(en[1].toLowerCase());
    let h = en[4] ? parseInt(en[4], 10) : 0;
    const ampm = en[6]?.toUpperCase();
    if (ampm === "PM" && h < 12) h += 12;
    if (ampm === "AM" && h === 12) h = 0;
    // bare wall-clock time: interpret as Asia/Shanghai like other exports
    const utcMs = Date.UTC(+en[3], mo, +en[2], h, en[5] ? +en[5] : 0, 0) - 8 * 3600_000;
    return toUtcSql(new Date(utcMs));
  }
  // has explicit zone info -> trust it
  if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) return toUtcSql(new Date(s));
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return toUtcSql(new Date(s));
  const [, y, mo, d, h = "0", mi = "0", se = "0"] = m;
  // interpret as Asia/Shanghai local time
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - 8 * 3600_000;
  return toUtcSql(new Date(utcMs));
}

/** Extract inline #tag tokens (flomo style), returning [tags, content-unchanged]. */
export function extractHashTags(content: string, max = 5): string[] {
  const tags: string[] = [];
  for (const m of content.matchAll(/#([\p{L}\p{N}_\-/]{1,24})/gu)) {
    const t = m[1].trim();
    if (t && !tags.includes(t) && tags.length < max) tags.push(t);
  }
  return tags;
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'）)\]】，,；;]+/;

export function firstUrl(text: string): string | null {
  const m = text.match(URL_IN_TEXT_RE);
  return m ? m[0] : null;
}

function clip(s: string): string {
  return s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS) : s;
}

export const clipContent = clip;

// ---- CSV (RFC 4180-ish, tolerant) ----

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

// ---- Cubox ----

// Header aliases across Cubox versions (Chinese / English exports).
const CUBOX_COLS: Record<string, string[]> = {
  title: ["标题", "title", "name"],
  description: ["描述", "description", "desc"],
  url: ["链接", "网址", "url", "link"],
  tags: ["标签", "tags", "tag"],
  folder: ["文件夹", "分组", "收藏夹", "folder", "group"],
  created: ["创建时间", "收藏时间", "created", "create time", "created at", "create_time"],
  content: ["内容", "正文", "content", "text"],
};

function matchCol(header: string[], aliases: string[]): number {
  const lower = header.map((h) => h.trim().toLowerCase());
  for (const a of aliases) {
    const i = lower.indexOf(a.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

export function splitTags(raw: string): string[] {
  return raw
    .split(/[,，;；#|]/)
    .map((t) => t.trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 5);
}

export function parseCuboxCsv(text: string): ImportItem[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0];
  const col = Object.fromEntries(
    Object.entries(CUBOX_COLS).map(([k, aliases]) => [k, matchCol(header, aliases)])
  ) as Record<keyof typeof CUBOX_COLS, number>;
  if (col.url < 0 && col.title < 0 && col.content < 0) return [];
  const items: ImportItem[] = [];
  for (const row of rows.slice(1, MAX_ITEMS + 1)) {
    const get = (i: number) => (i >= 0 && i < row.length ? row[i].trim() : "");
    const title = get(col.title);
    const desc = get(col.description);
    const url = get(col.url) || null;
    const body = get(col.content);
    const parts = [title, desc && desc !== title ? desc : "", body && body !== desc ? body : "", url ?? ""]
      .filter(Boolean);
    const content = clip(parts.join("\n").trim());
    if (!content) continue;
    items.push({
      content,
      created_at: normalizeImportDate(get(col.created) || null),
      tags: splitTags(get(col.tags)),
      url: url && /^https?:\/\//.test(url) ? url : firstUrl(content),
    });
  }
  return items;
}

/** Netscape bookmark HTML (Cubox HTML export): <DT><A HREF ADD_DATE TAGS>title</A> */
export function parseBookmarkHtml(html: string): ImportItem[] {
  const items: ImportItem[] = [];
  const re = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && items.length < MAX_ITEMS) {
    const attrs = m[1];
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, "").trim());
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href || !/^https?:\/\//i.test(href)) continue;
    const addDate = attrs.match(/add_date=["'](\d+)["']/i)?.[1];
    const tagsAttr = attrs.match(/tags=["']([^"']*)["']/i)?.[1];
    const content = clip([title, decodeEntities(href)].filter(Boolean).join("\n"));
    items.push({
      content,
      created_at: normalizeImportDate(addDate ? parseInt(addDate, 10) : null),
      tags: tagsAttr ? splitTags(decodeEntities(tagsAttr)) : [],
      url: decodeEntities(href),
    });
  }
  return items;
}

export function parseCubox(text: string): ImportItem[] {
  const head = text.slice(0, 2000).toLowerCase();
  if (head.includes("<a ") && (head.includes("<!doctype netscape-bookmark") || head.includes("<dl") || head.includes("<html"))) {
    return parseBookmarkHtml(text);
  }
  const csv = parseCuboxCsv(text);
  if (csv.length > 0) return csv;
  // txt export fallback: blank-line separated blocks (title / url lines)
  return parsePlainText(text);
}

// ---- flomo ----

/** flomo HTML export: <div class="memo"><div class="time">…</div><div class="content">…</div></div> */
export function parseFlomo(html: string): ImportItem[] {
  const items: ImportItem[] = [];
  const blocks = html.split(/<div[^>]*class=["'][^"']*\bmemo\b[^"']*["'][^>]*>/i).slice(1);
  for (const block of blocks.slice(0, MAX_ITEMS)) {
    const timeM = block.match(/class=["'][^"']*\btime\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const contentM = block.match(/class=["'][^"']*\bcontent\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
    const content = clip(htmlToText(contentM ? contentM[1] : block));
    if (!content) continue;
    items.push({
      content,
      created_at: normalizeImportDate(timeM ? htmlToText(timeM[1]) : null),
      tags: extractHashTags(content),
      url: firstUrl(content),
    });
  }
  if (items.length > 0) return items;
  // markdown-style flomo export fallback
  return parseMarkdown(html);
}

// ---- generic Markdown / plain text ----

/**
 * Generic Markdown: split into one note per `---` horizontal rule section, or
 * per heading section when there are no rules; a single-section file becomes
 * one note. A leading "YYYY-MM-DD HH:MM" line in a section is used as the
 * original created time.
 */
export function parseMarkdown(text: string): ImportItem[] {
  const src = text.replace(/\r\n/g, "\n").trim();
  if (!src) return [];
  let sections: string[];
  if (/\n-{3,}\s*\n/.test(src)) {
    sections = src.split(/\n-{3,}\s*\n/);
  } else if ((src.match(/^#{1,3} /gm) || []).length >= 2) {
    sections = src.split(/\n(?=#{1,3} )/);
  } else {
    return blocksToItems(src.split(/\n\s*\n/));
  }
  return blocksToItems(sections);
}

export function parsePlainText(text: string): ImportItem[] {
  const src = text.replace(/\r\n/g, "\n").trim();
  if (!src) return [];
  return blocksToItems(src.split(/\n\s*\n/));
}

const LEADING_DATE_RE = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T ]\d{1,2}:\d{1,2}(?::\d{1,2})?)?)\s*$/;

function blocksToItems(blocks: string[]): ImportItem[] {
  const items: ImportItem[] = [];
  for (const raw of blocks.slice(0, MAX_ITEMS)) {
    const lines = raw.trim().split("\n");
    let created: string | null = null;
    // date-only first line (or "date:" front-matter style) = original created time
    const first = lines[0]?.trim() ?? "";
    const dateM = first.match(LEADING_DATE_RE) || first.match(/^date:\s*(.+)$/i);
    if (dateM) {
      const norm = normalizeImportDate(dateM[1]);
      if (norm) {
        created = norm;
        lines.shift();
      }
    }
    const content = clip(lines.join("\n").replace(/^#{1,6} /, "").trim());
    if (!content) continue;
    items.push({ content, created_at: created, tags: extractHashTags(content), url: firstUrl(content) });
  }
  return items;
}

// ---- import execution ----

export interface ImportStats {
  total: number;
  imported: number;
  skipped: number;
  failed: number;
}

export interface ImportRunResult {
  stats: ImportStats;
  failures: ImportFailure[];
}

export interface ImportRunOptions {
  /** Called after each processed batch with running progress. */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

const CHUNK = 40;

function itemHead(item: ImportItem): string {
  return item.content.replace(/\s+/g, " ").slice(0, 60);
}

/**
 * Insert parsed items as notes for `userId`, preserving the original created
 * time and tags. Duplicates (same content + same created time) are skipped.
 * Notes are inserted with category NULL so the existing cron sweep
 * (retriage / embeddings / graph / link extraction) processes them gradually
 * without bursting the AI quota; original tags are kept in meta.import_tags
 * and merged back after AI triage. Image assets (zip imports) are stored in
 * R2 and recorded in attachments.
 */
export async function runImport(
  env: { DB: D1Database; MEDIA?: R2Bucket },
  userId: string,
  source: ImportSource,
  items: ImportItem[],
  opts: ImportRunOptions = {}
): Promise<ImportRunResult> {
  const db = env.DB;
  const stats: ImportStats = { total: items.length, imported: 0, skipped: 0, failed: 0 };
  const failures: ImportFailure[] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);
    try {
      // dedup: fetch existing notes matching any of the chunk's contents in one query
      const ph = chunk.map(() => "?").join(",");
      const existing = await db
        .prepare(`SELECT content, created_at FROM notes WHERE user_id = ? AND content IN (${ph})`)
        .bind(userId, ...chunk.map((it) => it.content))
        .all<{ content: string; created_at: string }>();
      const seen = new Set((existing.results ?? []).map((r) => `${r.created_at}\u0000${r.content}`));
      const noTime = new Set((existing.results ?? []).map((r) => r.content));
      const stmts: D1PreparedStatement[] = [];
      const inserted: { id: string; item: ImportItem }[] = [];
      const insert = db.prepare(
        `INSERT INTO notes (id, user_id, source, raw_type, content, url, category, tags, meta, created_at, updated_at)
         VALUES (?, ?, 'import', ?, ?, ?, NULL, ?, ?, ?, ?)`
      );
      for (const item of chunk) {
        const createdAt = item.created_at ?? toUtcSql(new Date())!;
        const dup = item.created_at ? seen.has(`${createdAt}\u0000${item.content}`) : noTime.has(item.content);
        if (dup) {
          stats.skipped++;
          continue;
        }
        seen.add(`${createdAt}\u0000${item.content}`);
        noTime.add(item.content);
        const meta: Record<string, unknown> = { import_source: source };
        if (item.tags.length > 0) meta.import_tags = item.tags;
        const id = crypto.randomUUID();
        inserted.push({ id, item });
        stmts.push(
          insert.bind(
            id,
            userId,
            item.url && item.content.startsWith(item.url) ? "link" : "text",
            item.content,
            item.url,
            JSON.stringify(item.tags),
            JSON.stringify(meta),
            createdAt,
            createdAt
          )
        );
      }
      if (stmts.length > 0) await db.batch(stmts);
      stats.imported += stmts.length;
      // store image assets (zip imports) in R2 + attachments; an asset failure
      // never fails the note itself, it is only reported in the failure list
      for (const { id, item } of inserted) {
        for (const asset of item.assets ?? []) {
          if (!env.MEDIA) {
            failures.push({ item: itemHead(item), reason: `图片 ${asset.name} 未入库（未配置 R2）` });
            continue;
          }
          try {
            const safeName = asset.name.replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
            const key = `media/${userId}/${id}/${Date.now()}-${safeName}`;
            await env.MEDIA.put(key, asset.bytes, { httpMetadata: { contentType: asset.mime } });
            await db
              .prepare("INSERT INTO attachments (id, note_id, r2_key, mime, size) VALUES (?, ?, ?, ?, ?)")
              .bind(crypto.randomUUID(), id, key, asset.mime, asset.bytes.length)
              .run();
          } catch (e) {
            console.error("import asset failed", e);
            failures.push({ item: itemHead(item), reason: `图片 ${asset.name} 入库失败` });
          }
        }
      }
    } catch (e) {
      console.error("import chunk failed", e);
      stats.failed += chunk.length;
      for (const item of chunk) {
        failures.push({ item: itemHead(item), reason: e instanceof Error ? e.message : "写入失败" });
      }
    }
    await opts.onProgress?.(Math.min(i + CHUNK, items.length), items.length);
  }
  return { stats, failures };
}

// ---- entry ----

export function parseImportFile(source: ImportSource, text: string): ImportItem[] {
  switch (source) {
    case "cubox":
      return parseCubox(text);
    case "flomo":
      return parseFlomo(text);
    case "markdown":
      return parseMarkdown(text);
    case "text":
      return parsePlainText(text);
    default:
      // zip-based sources (notion / obsidian / apple-notes) are parsed by import-zip.ts
      return [];
  }
}
