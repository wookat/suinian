import type { Env } from "./types";
import { chatComplete, withTimeout } from "./ai";

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

export type MediaType = "audio" | "image" | "file";

export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export const AUDIO_FAILED_PLACEHOLDER = "【语音】转写失败，稍后可重发";
export const IMAGE_FAILED_PLACEHOLDER = "【图片】文字提取失败，稍后可重发";

export interface MediaIngestRequest {
  type: MediaType;
  bytes: Uint8Array;
  mime: string;
  fileName?: string;
  source?: string;
  /** Client-generated idempotency key: replays of the same upload return the existing note. */
  clientId?: string;
}

/** Parse /api/ingest/media body: multipart/form-data (file+type) or JSON base64. */
export async function parseMediaRequest(req: Request): Promise<MediaIngestRequest | { error: string; status: 400 | 413 }> {
  const contentType = req.headers.get("content-type") || "";
  let type: string | undefined;
  let bytes: Uint8Array | undefined;
  let mime = "application/octet-stream";
  let fileName: string | undefined;
  let source: string | undefined;
  let clientId: string | undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return { error: "invalid multipart body", status: 400 };
    type = (form.get("type") as string) || undefined;
    source = (form.get("source") as string) || undefined;
    clientId = (form.get("client_id") as string) || undefined;
    const file = form.get("file") as unknown as File | string | null;
    if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
      return { error: "file required", status: 400 };
    }
    if (file.size > MAX_MEDIA_BYTES) return { error: mediaTooLargeMessage(file.size), status: 413 };
    bytes = new Uint8Array(await file.arrayBuffer());
    mime = file.type || mime;
    fileName = file.name || undefined;
  } else {
    const body = await req
      .json<{ type?: string; data_base64?: string; mime?: string; file_name?: string; source?: string; client_id?: string }>()
      .catch(() => null);
    if (!body?.data_base64) return { error: "data_base64 required", status: 400 };
    // base64 length * 3/4 approximates decoded size; reject before decoding huge payloads
    if (body.data_base64.length * 0.75 > MAX_MEDIA_BYTES) {
      return { error: mediaTooLargeMessage(Math.floor(body.data_base64.length * 0.75)), status: 413 };
    }
    try {
      bytes = Uint8Array.from(atob(body.data_base64), (ch) => ch.charCodeAt(0));
    } catch {
      return { error: "invalid base64 data", status: 400 };
    }
    if (bytes.length > MAX_MEDIA_BYTES) return { error: mediaTooLargeMessage(bytes.length), status: 413 };
    type = body.type;
    mime = body.mime || mime;
    fileName = body.file_name;
    source = body.source;
    clientId = body.client_id;
  }

  if (type !== "audio" && type !== "image" && type !== "file") {
    return { error: "type must be audio, image or file", status: 400 };
  }
  if (!bytes || bytes.length === 0) return { error: "empty file", status: 400 };
  if (clientId && !/^[\w-]{1,64}$/.test(clientId)) clientId = undefined;
  return { type, bytes, mime, fileName, source, clientId };
}

export function mediaTooLargeMessage(size: number): string {
  return `文件过大：最多 ${MAX_MEDIA_BYTES / 1024 / 1024}MB，当前约 ${(size / 1024 / 1024).toFixed(1)}MB。`;
}

/** Build the WeChat/web confirmation reply, e.g. 已记录（语音转写）：<前30字> */
export function buildMediaReply(type: MediaType, text: string, ok: boolean): string {
  const label = type === "audio" ? "语音转写" : "图片识别";
  if (!ok) return `已记录（${label}失败，已存占位，稍后可重发）`;
  const head = text.replace(/\s+/g, " ").trim().slice(0, 30);
  return `已记录（${label}）：${head}${text.trim().length > 30 ? "…" : ""}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const AI_RUN_TIMEOUT_MS = 25_000;
const CORRECT_TIMEOUT_MS = 10_000;

export { withTimeout } from "./ai";

/** Whisper transcription via Workers AI; returns null on any failure. */
export async function transcribeAudio(env: Pick<Env, "AI">, bytes: Uint8Array): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const out = (await withTimeout(
      env.AI.run(WHISPER_MODEL as Parameters<Ai["run"]>[0], {
        audio: bytesToBase64(bytes),
      }) as Promise<{ text?: string }>,
      AI_RUN_TIMEOUT_MS,
      "whisper"
    )) as { text?: string };
    const text = (out.text ?? "").trim();
    return text || null;
  } catch (err) {
    console.error("transcribeAudio: failed", err);
    return null;
  }
}

const CORRECT_SYSTEM_PROMPT =
  "你是语音转写纠错助手。修正下面转写文本中的同音错别字与明显断句错误，不改变原意，不增删信息，输出纯文本（不要解释，不要 markdown）。";

const CORRECTION_REFUSAL_RE = /抱歉|无法(?:提供|协助|帮助|处理|完成)|不能(?:提供|协助|帮助|处理)|作为(?:一个)?(?:AI|人工智能|语言模型|助手)|(?:敏感|隐私|安全)(?:信息|内容|问题)|I(?:'m| am) sorry|I can(?:no|')t/i;

/**
 * 纠错模型对含密码/敏感词的转写可能拒答，把拒答文案当成纠错结果会静默替换
 * 用户原话（且拒答文本会被复判为非敏感）。命中拒答特征或长度严重失真时，
 * 一律回退原始转写，让下游敏感闸门基于真实内容判定。
 */
export function isCorrectionRefusal(text: string, raw: string): boolean {
  if (CORRECTION_REFUSAL_RE.test(text)) return true;
  const rawLen = Math.min(raw.length, 4000);
  return text.length > rawLen * 2 + 40 || text.length * 3 < rawLen;
}

/**
 * LLM post-correction of a Whisper transcript (homophone typos, obvious
 * segmentation errors). Returns the corrected text, or the original
 * transcript on any failure so the pipeline never regresses.
 */
export async function correctTranscript(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  raw: string
): Promise<string> {
  try {
    const out = await withTimeout(
      chatComplete(env, {
        temperature: 0.1,
        max_tokens: 1024,
        timeout_ms: CORRECT_TIMEOUT_MS,
        messages: [
          { role: "system", content: CORRECT_SYSTEM_PROMPT },
          { role: "user", content: raw.slice(0, 4000) },
        ],
      }),
      CORRECT_TIMEOUT_MS + 2_000,
      "transcript correction"
    );
    const text = (out ?? "").trim();
    if (!text || isCorrectionRefusal(text, raw)) return raw;
    return text;
  } catch (err) {
    console.error("correctTranscript: failed", err);
    return raw;
  }
}

const IMAGE_PROMPT =
  "你会看到一张图片。请按下面格式输出两部分，用中文回答，不要客套话，不要 markdown 格式（不要星号、井号）：\n" +
  "文字：<图片中的所有文字，保持原文不要翻译；若图中没有文字则输出「无」>\n" +
  "描述：<对图片内容的完整描述>";

/** Remove markdown emphasis/heading noise the vision model tends to emit. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*+/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .trim();
}

export interface ImageExtraction {
  /** Note content: extracted text, or a short description when the image has no text. */
  content: string;
  /** Full vision description for metadata. */
  description: string;
}

/** Parse the two-section vision output into content (text-first) + description. */
export function parseImageExtraction(raw: string): ImageExtraction {
  const cleaned = stripMarkdown(raw);
  const textMatch = cleaned.match(/(?:^|\n)\s*文字[:：]\s*([\s\S]*?)(?=\n\s*描述[:：]|$)/);
  const descMatch = cleaned.match(/(?:^|\n)\s*描述[:：]\s*([\s\S]*)/);
  const text = (textMatch?.[1] ?? "").trim();
  const desc = (descMatch?.[1] ?? "").trim();
  // models often echo the prompt's angle-bracket placeholder (e.g. "<无>");
  // strip wrapping brackets before deciding whether the image really has text
  const bare = text.replace(/^[<《【「(（\[]+/, "").replace(/[>》】」)）\]]+$/, "").trim();
  const hasText = bare.length > 0 && !/^(无|没有|无文字|N\/A|none)。?$/i.test(bare);
  if (hasText) return { content: bare, description: desc || cleaned };
  // no text in image: fall back to the first sentence of the description
  const fallback = desc || cleaned;
  const firstSentence = fallback.split(/(?<=[。！？!?])/)[0]?.trim() || fallback;
  return { content: firstSentence, description: fallback };
}

/** Vision model: text extraction (primary) + full description; returns null on any failure. */
export async function describeImage(env: Pick<Env, "AI">, bytes: Uint8Array): Promise<ImageExtraction | null> {
  if (!env.AI) return null;
  try {
    const out = (await withTimeout(
      env.AI.run(VISION_MODEL as Parameters<Ai["run"]>[0], {
        prompt: IMAGE_PROMPT,
        image: Array.from(bytes),
        max_tokens: 512,
      }) as Promise<{ response?: string }>,
      AI_RUN_TIMEOUT_MS,
      "vision"
    )) as { response?: string };
    const text = (out.response ?? "").trim();
    if (!text) return null;
    const extraction = parseImageExtraction(text);
    // never let an empty/placeholder-only extraction become note content;
    // callers fall back to the honest failure placeholder instead
    return extraction.content ? extraction : null;
  } catch (err) {
    console.error("describeImage: failed", err);
    return null;
  }
}

/** Objects newer than this are never treated as orphans (in-flight uploads: R2 put lands before the attachments row). */
export const RECONCILE_GRACE_MS = 48 * 3600_000;
/** Per-run object budget — keeps the daily sweep well inside cron limits. */
const RECONCILE_MAX_OBJECTS = 2000;
const RECONCILE_CHUNK = 50;

/**
 * R2↔attachments reconciliation (R127 P2-3 / D2): the upload / note-delete /
 * account-delete paths each touch R2 best-effort (fire-and-forget deletes),
 * so a failed leg leaves permanent orphan objects nobody notices. This daily
 * sweep lists the bucket, diffs keys against the attachments table, and
 * deletes objects past the grace period with no owning row. attachments is
 * the source of truth: an object without a row is unreachable by any user.
 */
export async function reconcileMediaOrphans(env: Env): Promise<number> {
  if (!env.MEDIA) return 0;
  let deleted = 0;
  let cursor: string | undefined;
  let seen = 0;
  const now = Date.now();
  try {
    for (;;) {
      const page = await env.MEDIA.list({ prefix: "media/", cursor, limit: 500 });
      const candidates = page.objects.filter((o) => now - o.uploaded.getTime() > RECONCILE_GRACE_MS);
      for (let i = 0; i < candidates.length; i += RECONCILE_CHUNK) {
        const chunk = candidates.slice(i, i + RECONCILE_CHUNK);
        const ph = chunk.map(() => "?").join(",");
        const rows = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE r2_key IN (${ph})`)
          .bind(...chunk.map((o) => o.key))
          .all<{ r2_key: string }>();
        const known = new Set((rows.results ?? []).map((r) => r.r2_key));
        const orphans = chunk.filter((o) => !known.has(o.key)).map((o) => o.key);
        if (orphans.length > 0) {
          await env.MEDIA.delete(orphans);
          deleted += orphans.length;
          console.warn(`reconcileMediaOrphans: deleted ${orphans.length} orphan object(s)`, orphans);
        }
      }
      seen += page.objects.length;
      if (page.truncated && seen < RECONCILE_MAX_OBJECTS) cursor = page.cursor;
      else break;
    }
  } catch (e) {
    console.error("reconcileMediaOrphans: failed", e);
  }
  return deleted;
}

/** Store the original media file in R2 (if bound) and record it in attachments. */
export async function storeOriginal(
  env: Env,
  userId: string,
  noteId: string,
  req: MediaIngestRequest
): Promise<string | null> {
  if (!env.MEDIA) return null;
  const safeName = (req.fileName || req.type).replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
  const key = `media/${userId}/${noteId}/${Date.now()}-${safeName}`;
  try {
    await env.MEDIA.put(key, req.bytes, { httpMetadata: { contentType: req.mime } });
    await env.DB.prepare("INSERT INTO attachments (id, note_id, r2_key, mime, size) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), noteId, key, req.mime, req.bytes.length)
      .run();
    return key;
  } catch (err) {
    console.error("storeOriginal: failed", err);
    return null;
  }
}
