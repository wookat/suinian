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

/** 根据文件名扩展名 + mime 判定支持的文件类型；不支持返回 null */
export function detectFileKind(fileName: string | undefined, mime: string): FileKind | null {
  const ext = fileName?.split(".").pop()?.toLowerCase();
  if (ext && EXT_KIND[ext]) return EXT_KIND[ext];
  const base = mime.split(";")[0].trim().toLowerCase();
  return MIME_KIND[base] ?? null;
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
    const text = new TextDecoder("utf-8").decode(bytes).trim();
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
  text: string
): Promise<FileSummary | null> {
  const out = await chatComplete(env, {
    temperature: 0.3,
    max_tokens: 400,
    timeout_ms: 20_000,
    messages: [
      {
        role: "system",
        content:
          '你是「碎念」文件归档摘要助手。根据文件名与正文，输出严格 JSON（不要 markdown 代码块），字段：\n- summary: 80-150 字中文摘要，概括文档讲了什么、核心信息/结论，客观陈述，不要"本文""该文档"开头\n- tags: 1-3 个中文短标签数组（主题词，不要 # 前缀）\n只输出 JSON。',
      },
      { role: "user", content: `文件名：${fileName}\n正文：\n${text.slice(0, SUMMARIZE_INPUT_CHARS)}` },
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
  const text = await extractFileText(kind, bytes);
  if (!text) {
    return { content: `${FILE_FAILED_PLACEHOLDER}：${fileName}`, excerpt: null, summarized: false, extracted: false };
  }
  if (text.length <= FILE_DIRECT_CHARS) {
    return { content: text, excerpt: null, summarized: false, extracted: true };
  }
  const excerpt = text.slice(0, FILE_EXCERPT_CHARS);
  const ai = await summarizeFileText(env, fileName, text);
  if (ai) {
    return { content: `【${fileName}】${ai.summary}`, excerpt, summarized: true, extracted: true };
  }
  // AI 不可用：截断原文入 content，仍可搜索
  return { content: text.slice(0, FILE_DIRECT_CHARS * 2), excerpt, summarized: false, extracted: true };
}

/** 微信/Web 的文件入库确认文案：已存档：<文件名> · <一句话摘要> */
export function buildFileReply(fileName: string, content: string, extracted: boolean): string {
  if (!extracted) return `已存档：${fileName}（文本提取失败，原件已保存，可稍后重发）`;
  const clean = content.replace(new RegExp(`^【${fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}】`), "");
  const head = clean.replace(/\s+/g, " ").trim().slice(0, 40);
  return `已存档：${fileName} · ${head}${clean.trim().length > 40 ? "…" : ""}`;
}
