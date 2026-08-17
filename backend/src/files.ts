import { unzipSync } from "fflate";
import { chatComplete } from "./ai";
import { sanitizeTags } from "./triage";
import type { Env } from "./types";
import { withTimeout } from "./media";

export type FileKind = "pdf" | "txt" | "md" | "docx" | "csv" | "xlsx";

/** 提取文本入 content 的直存上限；超过则先 AI 摘要，全文摘录进 meta */
export const FILE_DIRECT_CHARS = 600;
/** meta.file_excerpt 保存的全文摘录上限 */
export const FILE_EXCERPT_CHARS = 6000;
/** 送给 AI 摘要的正文上限 */
const SUMMARIZE_INPUT_CHARS = 8000;
const PDF_TIMEOUT_MS = 20_000;

export const FILE_FAILED_PLACEHOLDER = "【文件】文本提取失败，已存档原件";
export const FILE_BINARY_PLACEHOLDER = "【文件】扩展名是文本格式但内容是二进制数据（疑似图片等改名文件），未提取文本，已存档原件";

const EXT_KIND: Record<string, FileKind> = {
  pdf: "pdf",
  txt: "txt",
  md: "md",
  markdown: "md",
  docx: "docx",
  csv: "csv",
  tsv: "csv",
  xlsx: "xlsx",
};

const MIME_KIND: Record<string, FileKind> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/csv": "csv",
  "text/tab-separated-values": "csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/** 内容嗅探（magic bytes）：扩展名可伪装，内容特征可信（R168 P2-2）。
 * 只做高置信度的正向识别（PDF/OOXML zip）；嗅不出时返回 null 交扩展名/mime 判定。 */
export function sniffFileKind(bytes: Uint8Array): FileKind | null {
  // %PDF-
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return "pdf";
  }
  // PK\x03\x04（zip）：看内部结构区分 xlsx/docx；其他 zip 不认领
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    try {
      const files = unzipSync(bytes);
      if (files["xl/workbook.xml"]) return "xlsx";
      if (files["word/document.xml"]) return "docx";
    } catch {
      /* 损坏/非标准 zip：交扩展名判定 */
    }
  }
  return null;
}

/** 判定支持的文件类型：内容嗅探优先于扩展名，mime 兜底；不支持返回 null */
export function detectFileKind(fileName: string | undefined, mime: string, bytes?: Uint8Array): FileKind | null {
  if (bytes) {
    const sniffed = sniffFileKind(bytes);
    if (sniffed) return sniffed;
  }
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_KIND[base] ?? null;
}

/** 解码质量评分：常用字符（ASCII/CJK 基本区/中日标点/全角/假名）占比；
 * 替换符与私用区/生僻扩展区字符重罚（错编码解出的乱码典型落点）。 */
function decodeQuality(s: string): number {
  let good = 0;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd) {
      bad += 3;
    } else if (c < 0x80) {
      good++;
    } else if (
      (c >= 0x4e00 && c <= 0x9fff) ||
      (c >= 0x3000 && c <= 0x30ff) ||
      (c >= 0xff00 && c <= 0xffef) ||
      c === 0x2018 || c === 0x2019 || c === 0x201c || c === 0x201d || c === 0x2014 || c === 0x2026
    ) {
      good++;
    } else if ((c >= 0xe000 && c <= 0xf8ff) || (c >= 0x3400 && c <= 0x4dbf)) {
      bad += 2;
    } else {
      bad++;
    }
  }
  const total = good + bad;
  return total === 0 ? 1 : good / total;
}

function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 文本字节 → 字符串（R168 P2-1 / R170 P2-1）：BOM 嗅探 UTF-16，UTF-8 严格解码；
 * 失败后 GBK/Big5 双解码按质量评分择优（老版 Excel/WPS 导出 CSV 默认 GBK，
 * 台港导出常见 Big5），再失败用 UTF-8 替换符兜底（原件已存档）。
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  try {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  } catch {
    /* 编码不受支持：落入下方 UTF-8/GBK 链 */
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    // Big5 字节流会被 GBK 无异常地解成乱码，异常兜底链判不出来：必须比解码质量
    const gbk = tryDecode(bytes, "gbk");
    const big5 = tryDecode(bytes, "big5");
    if (gbk !== null && big5 !== null) {
      return decodeQuality(big5) > decodeQuality(gbk) ? big5 : gbk;
    }
    return gbk ?? big5 ?? new TextDecoder("utf-8").decode(bytes);
  }
}

/** 常见二进制格式 magic bytes（PNG/JPEG/GIF/RIFF/zip/gzip/7z/BMP/ELF/MZ）。 */
const BINARY_MAGICS: number[][] = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x52, 0x49, 0x46, 0x46], // RIFF（webp/wav/avi）
  [0x50, 0x4b, 0x03, 0x04], // zip（能嗅成 docx/xlsx 的在 sniffFileKind 已认领）
  [0x1f, 0x8b], // gzip
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x42, 0x4d], // BMP
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // MZ（exe）
];

/** 二进制内容嗅探（R170 P2-2）：PNG 等二进制文件伪装 .csv 绝不能当文本
 * 解码存入乱码。magic bytes 命中，或开头含 NUL/高密度控制字符即判二进制
 *（UTF-16 BOM 文本除外）。 */
export function looksBinaryText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return false;
  for (const magic of BINARY_MAGICS) {
    if (bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b)) return true;
  }
  const head = bytes.subarray(0, 2048);
  let control = 0;
  for (const b of head) {
    if (b === 0x00) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) control++;
  }
  return control / head.length > 0.1;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** docx（OOXML zip）→ 纯文本：解包 word/document.xml，按段落取 <w:t> 文本 */
export function extractDocxText(bytes: Uint8Array): string | null {
  try {
    const files = unzipSync(bytes);
    const doc = files["word/document.xml"];
    if (!doc) return null;
    const xml = new TextDecoder("utf-8").decode(doc);
    const paragraphs = xml.split(/<\/w:p>/);
    const lines: string[] = [];
    for (const p of paragraphs) {
      const runs = Array.from(p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)).map((m) =>
        decodeXmlEntities(m[1])
      );
      const line = runs.join("").trim();
      if (line) lines.push(line);
    }
    const text = lines.join("\n").trim();
    return text || null;
  } catch (err) {
    console.error("extractDocxText: failed", err);
    return null;
  }
}

/** xlsx（OOXML zip）→ 纯文本：解包 sharedStrings + 各 sheet，按行取单元格值 */
export function extractXlsxText(bytes: Uint8Array): string | null {
  try {
    const files = unzipSync(bytes);
    const dec = new TextDecoder("utf-8");
    const shared: string[] = [];
    const ss = files["xl/sharedStrings.xml"];
    if (ss) {
      const xml = dec.decode(ss);
      for (const m of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
        const texts = Array.from(m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)).map((t) =>
          decodeXmlEntities(t[1])
        );
        shared.push(texts.join(""));
      }
    }
    const lines: string[] = [];
    const sheetNames = Object.keys(files)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort();
    for (const name of sheetNames) {
      const xml = dec.decode(files[name]);
      for (const row of xml.split(/<\/row>/)) {
        const cells: string[] = [];
        for (const c of row.matchAll(/<c(\s[^>]*)?>([\s\S]*?)<\/c>/g)) {
          const attrs = c[1] ?? "";
          const inner = c[2];
          const t = attrs.match(/\st="([^"]+)"/)?.[1];
          if (t === "inlineStr") {
            const texts = Array.from(inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)).map((m) =>
              decodeXmlEntities(m[1])
            );
            cells.push(texts.join(""));
            continue;
          }
          const v = inner.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
          if (v === undefined) continue;
          if (t === "s") {
            const idx = parseInt(v, 10);
            cells.push(Number.isFinite(idx) && shared[idx] !== undefined ? shared[idx] : "");
          } else {
            cells.push(decodeXmlEntities(v));
          }
        }
        const line = cells.join("\t").trim();
        if (line) lines.push(line);
      }
    }
    const text = lines.join("\n").trim();
    return text || null;
  } catch (err) {
    console.error("extractXlsxText: failed", err);
    return null;
  }
}

/** PDF → 纯文本（unpdf / PDF.js serverless build）；失败返回 null */
export async function extractPdfText(bytes: Uint8Array): Promise<string | null> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await withTimeout(getDocumentProxy(new Uint8Array(bytes)), PDF_TIMEOUT_MS, "pdf parse");
    const { text } = await withTimeout(extractText(pdf, { mergePages: true }), PDF_TIMEOUT_MS, "pdf extract");
    const out = (Array.isArray(text) ? text.join("\n") : text ?? "").replace(/[ \t]+\n/g, "\n").trim();
    return out || null;
  } catch (err) {
    console.error("extractPdfText: failed", err instanceof Error ? err.stack || err.message : err);
    return null;
  }
}

/** 按类型提取文件文本；失败/无文本返回 null（原件仍存档） */
export async function extractFileText(kind: FileKind, bytes: Uint8Array): Promise<string | null> {
  if (kind === "txt" || kind === "md" || kind === "csv") {
    const text = decodeTextBytes(bytes).trim();
    return text || null;
  }
  if (kind === "docx") return extractDocxText(bytes);
  if (kind === "xlsx") return extractXlsxText(bytes);
  return extractPdfText(bytes);
}

export interface FileSummary {
  summary: string;
  tags: string[];
}

/** 长文档 AI 摘要（80-150 字中文 + 标签建议）；失败返回 null */
export async function summarizeFileText(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  fileName: string,
  text: string,
  lineCount?: number
): Promise<FileSummary | null> {
  // 行数等结构性数字由解析器确定性统计后注入 prompt，禁止 LLM 对被截断的
  // 正文自己数（R168 P2-3：6000 行文件摘要谎称「共 231 行」）
  const structure = lineCount !== undefined ? `结构统计（解析器精确统计，行数/条数以此为准）：全文共 ${lineCount} 行\n` : "";
  const out = await chatComplete(env, {
    temperature: 0.3,
    max_tokens: 400,
    timeout_ms: 20_000,
    messages: [
      {
        role: "system",
        content:
          '你是「碎念」文件归档摘要助手。根据文件名与正文，输出严格 JSON（不要 markdown 代码块），字段：\n- summary: 80-150 字中文摘要，概括文档讲了什么、核心信息/结论，客观陈述，不要"本文""该文档"开头；正文可能被截断，涉及行数/条数时只能使用「结构统计」给出的数字，绝不自己数\n- tags: 1-3 个中文短标签数组（主题词，不要 # 前缀）\n只输出 JSON。',
      },
      { role: "user", content: `文件名：${fileName}\n${structure}正文（超长已截断）：\n${text.slice(0, SUMMARIZE_INPUT_CHARS)}` },
    ],
  });
  if (!out) return null;
  let raw = out.trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { summary?: unknown; tags?: unknown };
    const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 500) : "";
    if (!summary) return null;
    const tags = Array.isArray(obj.tags)
      ? sanitizeTags(obj.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()))
      : [];
    return { summary, tags };
  } catch {
    return null;
  }
}

/** 文件入库结果：content 入笔记正文，excerpt 进 meta.file_excerpt */
export interface FileIngestResult {
  content: string;
  excerpt: string | null;
  summarized: boolean;
  extracted: boolean;
}

/**
 * 提取文本 → 决定笔记正文：短文本直接入 content；长文本 AI 摘要为 content，
 * 全文摘录存 meta.file_excerpt；提取失败则占位文案（原件已存档）。
 */
export async function buildFileNote(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  kind: FileKind,
  fileName: string,
  bytes: Uint8Array
): Promise<FileIngestResult> {
  // 二进制伪装文本扩展名（R170 P2-2）：先嗅探拒收，绝不把二进制字节当文本
  // 解码存入乱码（原件仍存档，回复友好提示）
  if ((kind === "txt" || kind === "md" || kind === "csv") && looksBinaryText(bytes)) {
    return { content: `${FILE_BINARY_PLACEHOLDER}：${fileName}`, excerpt: null, summarized: false, extracted: false };
  }
  const text = await extractFileText(kind, bytes);
  if (!text) {
    return { content: `${FILE_FAILED_PLACEHOLDER}：${fileName}`, excerpt: null, summarized: false, extracted: false };
  }
  if (text.length <= FILE_DIRECT_CHARS) {
    return { content: text, excerpt: null, summarized: false, extracted: true };
  }
  const excerpt = text.slice(0, FILE_EXCERPT_CHARS);
  const lineCount = text.split("\n").length;
  // 表格类文件的行数是用户关心的结构信息：解析器精确统计后确定性拼入正文，
  // 不依赖 LLM 措辞（R168 P2-3）
  const structSuffix = kind === "csv" || kind === "xlsx" ? `（全文共 ${lineCount} 行）` : "";
  const ai = await summarizeFileText(env, fileName, text, lineCount);
  if (ai) {
    return { content: `【${fileName}】${ai.summary}${structSuffix}`, excerpt, summarized: true, extracted: true };
  }
  // AI 不可用：截断原文入 content，仍可搜索
  return { content: `${text.slice(0, FILE_DIRECT_CHARS * 2)}${structSuffix}`, excerpt, summarized: false, extracted: true };
}

/** 微信/Web 的文件入库确认文案：已存档：<文件名> · <一句话摘要> */
export function buildFileReply(fileName: string, content: string, extracted: boolean): string {
  if (!extracted) {
    if (content.startsWith(FILE_BINARY_PLACEHOLDER)) {
      return `已存档：${fileName}（这个文件扩展名是文本格式，但内容是图片等二进制数据，未提取文本；原件已保存，如需识别请改回正确扩展名后重发）`;
    }
    return `已存档：${fileName}（文本提取失败，原件已保存，可稍后重发）`;
  }
  const clean = content.replace(new RegExp(`^【${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}】`), "");
  const head = clean.replace(/\s+/g, " ").trim().slice(0, 40);
  return `已存档：${fileName} · ${head}${clean.trim().length > 40 ? "…" : ""}`;
}
