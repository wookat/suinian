// Zip-based import parsers: Notion (Markdown & CSV export), Obsidian vault,
// Apple Notes (Exporter-style md/txt zip), flomo (HTML export zip). Each
// entry becomes a normalized ImportItem; referenced local image assets are
// collected for R2 storage.

import { unzipSync, strFromU8 } from "fflate";
import {
  type ImportItem,
  type ImportAsset,
  type ImportFailure,
  normalizeImportDate,
  extractHashTags,
  htmlToText,
  parseCsv,
  parseCubox,
  splitTags,
  firstUrl,
  clipContent,
  MAX_IMPORT_ITEMS,
} from "./import";

export type ZipImportSource = "notion" | "obsidian" | "apple-notes" | "flomo" | "cubox";

export interface ZipParseResult {
  items: ImportItem[];
  failures: ImportFailure[];
  /** 图片资产超限被丢弃的数量（R130 P2-2：丢弃必须可观测，口径同备份侧 attachments_redacted） */
  assets_dropped: number;
  /** 达到单次 MAX_IMPORT_ITEMS 上限、尚有条目未解析（R130 P2-3） */
  truncated: boolean;
}

/** Per-note asset cap; keeps a single import from flooding R2. */
const MAX_ASSETS_PER_NOTE = 3;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ASSETS = 100;

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

function imageMime(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME[ext] ?? null;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

/** Join a relative reference against a base directory, resolving ../ segments. */
function resolvePath(baseDir: string, ref: string): string {
  const parts = baseDir ? baseDir.split("/") : [];
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function safeDecodeURI(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Zip entries without the UTF-8 flag get their names decoded as latin-1; if
 * the underlying bytes are valid UTF-8, re-decode so CJK filenames (and the
 * titles derived from them) don't turn into mojibake.
 */
function fixZipName(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  const bytes = new Uint8Array(name.length);
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c > 0xff) return name; // contains non-latin1 chars: already decoded correctly
    bytes[i] = c;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return name;
  }
}

/** Unzip into path -> bytes, skipping macOS cruft and directory entries. */
export function unzipEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  const raw = unzipSync(bytes);
  const out: Record<string, Uint8Array> = {};
  for (const [path, data] of Object.entries(raw)) {
    if (path.endsWith("/")) continue;
    const base = baseName(path);
    if (path.startsWith("__MACOSX/") || base === ".DS_Store" || base.startsWith("._")) continue;
    out[fixZipName(path)] = data;
  }
  return out;
}

/** Notion filenames carry a 32-hex page id suffix: "Title 3fa85f64....md" */
const NOTION_ID_RE = / [0-9a-f]{32}(?=(\.\w+)?$)/;

function stripNotionId(name: string): string {
  return name.replace(NOTION_ID_RE, "");
}

interface CollectedAssets {
  assets: ImportAsset[];
  markers: Map<string, string>;
}

/**
 * Replace markdown image refs pointing at files inside the zip with a
 * 【图片：name】 marker and collect their bytes (capped per note / total).
 */
function collectImageRefs(
  body: string,
  mdDir: string,
  entries: Record<string, Uint8Array>,
  totalSoFar: { count: number; dropped: number }
): { body: string; assets: ImportAsset[] } {
  const assets: ImportAsset[] = [];
  const out = body.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, _alt: string, rawRef: string) => {
    const ref = safeDecodeURI(rawRef.trim());
    if (/^[a-z]+:\/\//i.test(ref)) return whole; // external URL: keep as-is
    const path = resolvePath(mdDir, ref);
    const data = entries[path];
    const mime = imageMime(path);
    const name = baseName(path);
    if (!data || !mime) return whole;
    if (assets.some((a) => a.name === name)) return `【图片：${name}】`; // 同名已收集
    if (assets.length < MAX_ASSETS_PER_NOTE && totalSoFar.count < MAX_TOTAL_ASSETS && data.length <= MAX_ASSET_BYTES) {
      assets.push({ name, mime, bytes: data });
      totalSoFar.count++;
    } else {
      // 超限丢弃必须可观测：正文占位标记仍在，但字节未入库
      totalSoFar.dropped++;
    }
    return `【图片：${name}】`;
  });
  return { body: out, assets };
}

// ---- Notion ----

const NOTION_CREATED_KEYS = ["created time", "created", "created at", "创建时间", "date"];
const NOTION_TAG_KEYS = ["tags", "tag", "标签", "multi-select"];
const NOTION_URL_KEYS = ["url", "link", "链接", "网址"];

/**
 * Notion "Markdown & CSV" export zip: one .md per page ("Title <32hex>.md"),
 * sub-pages and assets in a same-named folder, databases as "<name>.csv" +
 * "<name>_all.csv" with one .md per row. Property lines (Created time / Tags /
 * URL / ...) follow the title in database-row pages.
 */
export function parseNotionZip(entries: Record<string, Uint8Array>): ZipParseResult {
  const items: ImportItem[] = [];
  const failures: ImportFailure[] = [];
  const total = { count: 0, dropped: 0 };
  let truncated = false;

  // md-page title counts, used to skip duplicate CSV rows. Counted (not a set)
  // so that N same-title md pages only absorb N same-title rows — extra distinct
  // rows that merely share the title still get imported.
  const mdTitles = new Map<string, number>();
  const mdPaths = Object.keys(entries).filter((p) => p.toLowerCase().endsWith(".md"));
  for (const p of mdPaths) {
    const t = stripNotionId(baseName(p)).replace(/\.md$/i, "").trim();
    mdTitles.set(t, (mdTitles.get(t) ?? 0) + 1);
  }

  for (const path of mdPaths) {
    if (items.length >= MAX_IMPORT_ITEMS) {
      truncated = true;
      break;
    }
    try {
      const md = strFromU8(entries[path]);
      const lines = md.replace(/\r\n/g, "\n").split("\n");
      let title = stripNotionId(baseName(path)).replace(/\.md$/i, "").trim();
      let i = 0;
      if (lines[0]?.startsWith("# ")) {
        title = lines[0].slice(2).trim() || title;
        i = 1;
      }
      while (i < lines.length && lines[i].trim() === "") i++;
      // property block: consecutive "Key: Value" lines right after the title
      let created: string | null = null;
      let tags: string[] = [];
      let url: string | null = null;
      const propRe = /^([A-Za-z\u4e00-\u9fff][\w /\u4e00-\u9fff-]{0,30}):\s+(.+)$/;
      while (i < lines.length) {
        const m = lines[i].match(propRe);
        if (!m) break;
        const key = m[1].trim().toLowerCase();
        const value = m[2].trim();
        if (NOTION_CREATED_KEYS.includes(key)) created = normalizeImportDate(value) ?? created;
        else if (NOTION_TAG_KEYS.includes(key)) tags = splitTags(value);
        else if (NOTION_URL_KEYS.includes(key) && /^https?:\/\//.test(value)) url = value;
        i++;
      }
      let body = lines.slice(i).join("\n").trim();
      // internal page links -> plain text; image refs -> collected assets
      body = body.replace(/(?<!!)\[([^\]]+)\]\(([^)]+\.md)\)/gi, (whole, text: string, ref: string) =>
        /^[a-z]+:\/\//i.test(ref) ? whole : text
      );
      const collected = collectImageRefs(body, dirName(path), entries, total);
      body = collected.body;
      const content = clipContent([title, body].filter(Boolean).join("\n").trim());
      if (!content) continue;
      items.push({
        content,
        created_at: created,
        tags,
        url: url ?? firstUrl(content),
        assets: collected.assets.length > 0 ? collected.assets : undefined,
      });
    } catch (e) {
      failures.push({ item: baseName(path), reason: e instanceof Error ? e.message : "解析失败" });
    }
  }

  // databases: prefer "<name>_all.csv" (full rows), skip rows already imported as .md pages
  const csvPaths = Object.keys(entries).filter((p) => p.toLowerCase().endsWith(".csv"));
  const preferred = csvPaths.filter((p) => {
    if (/_all\.csv$/i.test(p)) return true;
    return !csvPaths.includes(p.replace(/\.csv$/i, "_all.csv"));
  });
  for (const path of preferred) {
    if (items.length >= MAX_IMPORT_ITEMS) {
      truncated = true;
      break;
    }
    try {
      const rows = parseCsv(strFromU8(entries[path]));
      if (rows.length < 2) continue;
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const nameCol = header.findIndex((h) => ["name", "title", "名称", "标题"].includes(h));
      const createdCol = header.findIndex((h) => NOTION_CREATED_KEYS.includes(h));
      const tagCol = header.findIndex((h) => NOTION_TAG_KEYS.includes(h));
      const urlCol = header.findIndex((h) => NOTION_URL_KEYS.includes(h));
      for (const row of rows.slice(1)) {
        if (items.length >= MAX_IMPORT_ITEMS) {
          truncated = true;
          break;
        }
        const name = nameCol >= 0 ? row[nameCol]?.trim() ?? "" : "";
        if (!name) continue;
        const dup = mdTitles.get(name) ?? 0;
        if (dup > 0) {
          mdTitles.set(name, dup - 1); // row exists as an .md page
          continue;
        }
        const extras = row
          .map((v, idx) => ({ v: (v ?? "").trim(), idx }))
          .filter(({ v, idx }) => v && idx !== nameCol && idx !== createdCol && idx !== tagCol && idx !== urlCol)
          .map(({ v, idx }) => `${rows[0][idx].trim()}: ${v}`);
        const url = urlCol >= 0 && /^https?:\/\//.test(row[urlCol] ?? "") ? row[urlCol].trim() : null;
        const content = clipContent([name, url ?? "", ...extras].filter(Boolean).join("\n"));
        items.push({
          content,
          created_at: createdCol >= 0 ? normalizeImportDate(row[createdCol] ?? null) : null,
          tags: tagCol >= 0 ? splitTags(row[tagCol] ?? "") : [],
          url: url ?? firstUrl(content),
        });
      }
    } catch (e) {
      failures.push({ item: baseName(path), reason: e instanceof Error ? e.message : "解析失败" });
    }
  }

  return { items, failures, assets_dropped: total.dropped, truncated };
}

// ---- Obsidian ----

interface Frontmatter {
  created: string | null;
  tags: string[];
  title: string | null;
  body: string;
}

/** Minimal YAML frontmatter parse: created/date + tags (inline list, comma, or dash list) + title. */
export function parseFrontmatter(md: string): Frontmatter {
  const src = md.replace(/\r\n/g, "\n");
  const out: Frontmatter = { created: null, tags: [], title: null, body: src.trim() };
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return out;
  out.body = src.slice(m[0].length).trim();
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (["created", "created_at", "date", "ctime", "creation date"].includes(key)) {
      out.created = normalizeImportDate(value) ?? out.created;
    } else if (key === "title") {
      out.title = value || null;
    } else if (key === "tags" || key === "tag") {
      if (value.startsWith("[")) {
        out.tags = splitTags(value.replace(/^\[|\]$/g, ""));
      } else if (value) {
        out.tags = splitTags(value);
      } else {
        // block list:  tags:\n  - a\n  - b
        const collected: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const item = lines[j].match(/^\s+-\s+(.+)$/);
          if (!item) break;
          collected.push(item[1].trim().replace(/^["']|["']$/g, ""));
        }
        out.tags = collected.slice(0, 5);
      }
    }
  }
  return out;
}

const FILENAME_DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/**
 * Obsidian vault zip: every .md is a note (title = filename). Frontmatter
 * tags/created are honored; [[wikilinks]] stay as plain text; ![[embeds]]
 * that resolve to images inside the vault are stored as assets.
 */
export function parseObsidianZip(entries: Record<string, Uint8Array>): ZipParseResult {
  const items: ImportItem[] = [];
  const failures: ImportFailure[] = [];
  const total = { count: 0, dropped: 0 };
  let truncated = false;
  const paths = Object.keys(entries).filter((p) => {
    if (!p.toLowerCase().endsWith(".md")) return false;
    const parts = p.split("/");
    return !parts.some((seg) => seg === ".obsidian" || seg === ".trash");
  });
  for (const path of paths) {
    if (items.length >= MAX_IMPORT_ITEMS) {
      truncated = true;
      break;
    }
    try {
      const fm = parseFrontmatter(strFromU8(entries[path]));
      const name = baseName(path).replace(/\.md$/i, "").trim();
      let body = fm.body;
      // image embeds ![[path]] -> assets; other embeds/wikilinks -> plain text
      const assets: ImportAsset[] = [];
      body = body.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, (whole, rawRef: string) => {
        const ref = rawRef.trim();
        const mime = imageMime(ref);
        if (!mime) return whole;
        // Obsidian resolves embeds vault-wide; try relative then any suffix match
        const rel = resolvePath(dirName(path), ref);
        const found =
          entries[rel] !== undefined ? rel : Object.keys(entries).find((p) => p === ref || p.endsWith(`/${ref}`));
        const assetName = baseName(ref);
        if (found && !assets.some((a) => a.name === assetName)) {
          if (entries[found].length <= MAX_ASSET_BYTES && assets.length < MAX_ASSETS_PER_NOTE && total.count < MAX_TOTAL_ASSETS) {
            assets.push({ name: assetName, mime, bytes: entries[found] });
            total.count++;
          } else {
            total.dropped++;
          }
        }
        return `【图片：${assetName}】`;
      });
      body = body.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1");
      const title = fm.title ?? name;
      const content = clipContent(
        body.startsWith(`# ${title}`) || body.split("\n")[0]?.trim() === title
          ? body
          : [title, body].filter(Boolean).join("\n").trim()
      );
      if (!content) continue;
      const created = fm.created ?? normalizeImportDate(name.match(FILENAME_DATE_RE)?.[1] ?? null);
      const tags = fm.tags.length > 0 ? fm.tags : extractHashTags(content);
      items.push({
        content,
        created_at: created,
        tags,
        url: firstUrl(content),
        assets: assets.length > 0 ? assets : undefined,
      });
    } catch (e) {
      failures.push({ item: baseName(path), reason: e instanceof Error ? e.message : "解析失败" });
    }
  }
  return { items, failures, assets_dropped: total.dropped, truncated };
}

// ---- Apple Notes (Exporter-style md/txt zip) ----

/**
 * Apple Notes has no official bulk export; the common migration path is the
 * free "Exporter" Mac app (or similar tools), which writes one .md/.txt per
 * note into folders named after the Notes.app notebooks, optionally with a
 * frontmatter header and/or the creation date appended to the filename.
 * The notebook folder becomes a tag; images in the same folder are stored.
 */
export function parseAppleNotesZip(entries: Record<string, Uint8Array>): ZipParseResult {
  const items: ImportItem[] = [];
  const failures: ImportFailure[] = [];
  const total = { count: 0, dropped: 0 };
  let truncated = false;
  const paths = Object.keys(entries).filter((p) => /\.(md|markdown|txt)$/i.test(p));
  for (const path of paths) {
    if (items.length >= MAX_IMPORT_ITEMS) {
      truncated = true;
      break;
    }
    try {
      const fm = parseFrontmatter(strFromU8(entries[path]));
      const rawName = baseName(path).replace(/\.(md|markdown|txt)$/i, "").trim();
      // "Title - 2023-06-02" / "2023-06-02 Title" filename date conventions
      const nameDate = rawName.match(FILENAME_DATE_RE)?.[1] ?? null;
      const name = rawName
        .replace(/\s*[-–—]\s*\d{4}-\d{2}-\d{2}( \d{2}[.:]\d{2}([.:]\d{2})?)?$/, "")
        .replace(/^\d{4}-\d{2}-\d{2}( \d{2}[.:]\d{2}([.:]\d{2})?)?\s*[-–—]?\s*/, "")
        .trim();
      const collected = collectImageRefs(fm.body, dirName(path), entries, total);
      const body = collected.body;
      const title = fm.title ?? name;
      const content = clipContent(
        title && !(body.startsWith(`# ${title}`) || body.split("\n")[0]?.trim() === title)
          ? [title, body].filter(Boolean).join("\n").trim()
          : body
      );
      if (!content) continue;
      // notebook folder -> tag (Exporter mirrors Notes.app folders)
      const folder = path.includes("/") ? path.split("/")[0].trim() : "";
      const tags = [...fm.tags];
      if (folder && !tags.includes(folder) && tags.length < 5) tags.push(folder);
      items.push({
        content,
        created_at: fm.created ?? normalizeImportDate(nameDate),
        tags,
        url: firstUrl(content),
        assets: collected.assets.length > 0 ? collected.assets : undefined,
      });
    } catch (e) {
      failures.push({ item: baseName(path), reason: e instanceof Error ? e.message : "解析失败" });
    }
  }
  return { items, failures, assets_dropped: total.dropped, truncated };
}

// ---- flomo (HTML export zip) ----

/**
 * flomo 导出 zip：根目录一个 HTML（memo 列表，结构同纯 HTML 导出）+ file/ 下的
 * 图片附件。复用既有 zip 图片资产管线：<img src> 指向包内文件时收集字节入
 * R2，正文留【图片：name】占位标记（口径同 Notion/Obsidian/Apple 导入）。
 */
export function parseFlomoZip(entries: Record<string, Uint8Array>): ZipParseResult {
  const items: ImportItem[] = [];
  const failures: ImportFailure[] = [];
  const total = { count: 0, dropped: 0 };
  let truncated = false;
  const htmlPaths = Object.keys(entries).filter((p) => /\.html?$/i.test(p));
  if (htmlPaths.length === 0) {
    return {
      items,
      failures: [{ item: "zip", reason: "未找到 flomo 导出的 HTML 文件，请确认是 flomo 导出的完整 zip" }],
      assets_dropped: 0,
      truncated: false,
    };
  }
  const markerRe = /【图片：[^】]+】/g;
  for (const path of htmlPaths) {
    if (truncated) break;
    const html = strFromU8(entries[path]);
    const blocks = html.split(/<div[^>]*class=["'][^"']*\bmemo\b[^"']*["'][^>]*>/i).slice(1);
    for (const block of blocks) {
      if (items.length >= MAX_IMPORT_ITEMS) {
        truncated = true;
        break;
      }
      try {
        const timeM = block.match(/class=["'][^"']*\btime\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        const assets: ImportAsset[] = [];
        // 包内图片 -> 资产 + 占位标记；外链/无法解析的 img 直接去除
        const withMarkers = block.replace(/<img[^>]*\bsrc=["']([^"']+)["'][^>]*\/?>/gi, (_whole, rawRef: string) => {
          const ref = safeDecodeURI(rawRef.trim());
          if (/^[a-z]+:/i.test(ref)) return "";
          const p = resolvePath(dirName(path), ref);
          const data = entries[p];
          const mime = imageMime(p);
          const name = baseName(p);
          if (!data || !mime) return "";
          if (assets.some((a) => a.name === name)) return `【图片：${name}】`;
          if (assets.length < MAX_ASSETS_PER_NOTE && total.count < MAX_TOTAL_ASSETS && data.length <= MAX_ASSET_BYTES) {
            assets.push({ name, mime, bytes: data });
            total.count++;
          } else {
            total.dropped++;
          }
          return `【图片：${name}】`;
        });
        const contentM = withMarkers.match(/class=["'][^"']*\bcontent\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
        let content = clipContent(htmlToText(contentM ? contentM[1] : withMarkers));
        // flomo 把图片放在 content 之外的 files 区：只取 content 会丢标记，补附到正文末尾
        const inBody = new Set(content.match(markerRe) ?? []);
        const extra = [...new Set((withMarkers.match(markerRe) ?? []).filter((m) => !inBody.has(m)))];
        if (extra.length > 0) content = clipContent([content, ...extra].filter(Boolean).join("\n"));
        if (!content) continue;
        items.push({
          content,
          created_at: normalizeImportDate(timeM ? htmlToText(timeM[1]) : null),
          tags: extractHashTags(content),
          url: firstUrl(content),
          assets: assets.length > 0 ? assets : undefined,
        });
      } catch (e) {
        failures.push({ item: baseName(path), reason: e instanceof Error ? e.message : "解析失败" });
      }
    }
  }
  if (items.length === 0 && failures.length === 0) {
    failures.push({ item: "zip", reason: "HTML 中未解析到任何 memo，请确认是 flomo 导出的完整 zip" });
  }
  return { items, failures, assets_dropped: total.dropped, truncated };
}

// ---- Cubox (zip of csv / bookmark html / txt / md) ----

/**
 * Cubox 桌面端可把导出打成 zip：包内是 CSV / 书签 HTML / txt（逐文件走
 * parseCubox），或每条收藏一个 .md（走 Obsidian 同款 md 管线，标题/图片
 * 口径一致）。
 */
export function parseCuboxZip(entries: Record<string, Uint8Array>): ZipParseResult {
  const md = parseObsidianZip(entries);
  const items = [...md.items];
  const failures = [...md.failures];
  let truncated = md.truncated;
  for (const path of Object.keys(entries).filter((p) => /\.(csv|html?|txt)$/i.test(p))) {
    if (items.length >= MAX_IMPORT_ITEMS) {
      truncated = true;
      break;
    }
    try {
      const parsed = parseCubox(strFromU8(entries[path]));
      items.push(...parsed.slice(0, MAX_IMPORT_ITEMS - items.length));
    } catch (e) {
      failures.push({ item: baseName(path), reason: e instanceof Error ? e.message : "解析失败" });
    }
  }
  if (items.length === 0 && failures.length === 0) {
    failures.push({ item: "zip", reason: "zip 中未找到 Cubox 导出的 CSV / HTML / txt / md 文件" });
  }
  return { items, failures, assets_dropped: md.assets_dropped, truncated };
}

// ---- entry ----

export function parseImportZip(source: ZipImportSource, bytes: Uint8Array): ZipParseResult {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipEntries(bytes);
  } catch {
    return { items: [], failures: [{ item: "zip", reason: "压缩包无法解压，请确认是有效的 zip 文件" }], assets_dropped: 0, truncated: false };
  }
  switch (source) {
    case "notion":
      return parseNotionZip(entries);
    case "obsidian":
      return parseObsidianZip(entries);
    case "apple-notes":
      return parseAppleNotesZip(entries);
    case "flomo":
      return parseFlomoZip(entries);
    case "cubox":
      return parseCuboxZip(entries);
  }
}
