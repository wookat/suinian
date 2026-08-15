// 写入层统一敏感管道（R122 P1-1，收口 R121 §5.1/D3）：
// 一条笔记不论从哪个入口进入系统（速记 /api/notes、导入 /api/import、备份恢复
// /api/backup/restore、微信、MCP、扩展、Android——后四者都经 createNote），
// 落库前都必须过同一段敏感口径：
//   1. fail-closed 预检：内容确定（detectSensitive）或疑似（maybeSensitive）含
//      秘密值 → 明文立即进 content_enc，content 只留占位符；
//   2. 敏感元数据洗净：title 置空、tags 走 sanitizeSensitiveTags 严格过滤；
//   3. 疑似但未定论的（needs_retriage）交回模型主判，applyTriage 判非敏感时
//      恢复明文。
// 每个入口各抄一份口径是 R117→R119→R121 连续三轮同型缺陷的根因，禁止再绕开。
import { detectSensitive, maybeSensitive, sanitizeSensitiveTags } from "./triage";
import { encryptContent, ENC_PLACEHOLDER } from "./crypto";
import type { NoteMeta } from "./types";

// 派生明文闭包（R126 P1-1，落实 R125 D1）：这些 meta 字段都是从正文派生出的
// 明文（语音原始转写 / 图片描述 / 文件全文摘录 / 链接正文摘录），敏感笔记的
// content 加密后它们必须一并洗净，否则导出/备份会从字段维度把秘密带出去。
export const DERIVED_PLAINTEXT_META_KEYS = [
  "raw_transcript",
  "image_description",
  "file_excerpt",
  "link_excerpt",
] as const satisfies readonly (keyof NoteMeta)[];

/** 敏感笔记的派生明文 meta 字段统一洗净口径（写入层与导出/备份层共用）。 */
export function scrubDerivedMeta(meta: NoteMeta | null): NoteMeta | null {
  if (!meta) return null;
  if (!DERIVED_PLAINTEXT_META_KEYS.some((k) => meta[k] !== undefined)) return meta;
  const m = { ...meta };
  for (const k of DERIVED_PLAINTEXT_META_KEYS) delete m[k];
  return m;
}

export interface IncomingNoteFields {
  content: string;
  title: string | null;
  tags: string[];
  /** 入口自带的敏感定论（备份/导出字段），无则 false */
  is_sensitive: boolean;
}

export interface GatedNoteFields {
  content: string;
  content_enc: string | null;
  title: string | null;
  tags: string[];
  is_sensitive: boolean;
  /** true = 仅疑似（fail-closed 预检命中但无定论），需模型复判后定夺 */
  needs_retriage: boolean;
}

/**
 * The single sensitive-ingestion gate every note-writing path must go through.
 * `rejudge` = a model verdict will follow (async triage / cron retriage): the
 * broad maybeSensitive hint applies and hint-only hits are marked
 * needs_retriage. `rejudge:false` (skip-triage paths) uses only the
 * high-precision detector — a broad hint would stay encrypted forever.
 */
export async function sensitiveIngestGate(
  env: { SUINIAN_ENC_KEY?: string },
  n: IncomingNoteFields,
  opts: { rejudge: boolean } = { rejudge: true }
): Promise<GatedNoteFields> {
  const hint = n.is_sensitive
    ? false
    : opts.rejudge
      ? maybeSensitive(n.content)
      : detectSensitive(n.content);
  const sensitive = n.is_sensitive || hint;
  if (!sensitive) {
    return { content: n.content, content_enc: null, title: n.title, tags: n.tags, is_sensitive: false, needs_retriage: false };
  }
  let content = n.content;
  let contentEnc: string | null = null;
  // already-redacted placeholders carry no plaintext to encrypt
  if (n.content !== ENC_PLACEHOLDER && env.SUINIAN_ENC_KEY) {
    try {
      contentEnc = await encryptContent(env.SUINIAN_ENC_KEY, n.content);
      content = ENC_PLACEHOLDER;
    } catch {
      contentEnc = null;
    }
  }
  return {
    content,
    content_enc: contentEnc,
    // 敏感元数据洗净（R120 P1-1 同一口径）：title 可能原样抄入秘密值，一律置空；
    // tags 只留纯主题词
    title: null,
    tags: sanitizeSensitiveTags(n.tags),
    is_sensitive: true,
    needs_retriage: hint && opts.rejudge,
  };
}
