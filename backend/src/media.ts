import type { Env } from "./types";

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

export type MediaType = "audio" | "image";

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
}

/** Parse /api/ingest/media body: multipart/form-data (file+type) or JSON base64. */
export async function parseMediaRequest(req: Request): Promise<MediaIngestRequest | { error: string; status: 400 | 413 }> {
  const contentType = req.headers.get("content-type") || "";
  let type: string | undefined;
  let bytes: Uint8Array | undefined;
  let mime = "application/octet-stream";
  let fileName: string | undefined;
  let source: string | undefined;

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    if (!form) return { error: "invalid multipart body", status: 400 };
    type = (form.get("type") as string) || undefined;
    source = (form.get("source") as string) || undefined;
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
      .json<{ type?: string; data_base64?: string; mime?: string; file_name?: string; source?: string }>()
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
  }

  if (type !== "audio" && type !== "image") return { error: "type must be audio or image", status: 400 };
  if (!bytes || bytes.length === 0) return { error: "empty file", status: 400 };
  return { type, bytes, mime, fileName, source };
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

/** Whisper transcription via Workers AI; returns null on any failure. */
export async function transcribeAudio(env: Pick<Env, "AI">, bytes: Uint8Array): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const out = (await env.AI.run(WHISPER_MODEL as Parameters<Ai["run"]>[0], {
      audio: bytesToBase64(bytes),
    })) as { text?: string };
    const text = (out.text ?? "").trim();
    return text || null;
  } catch (err) {
    console.error("transcribeAudio: failed", err);
    return null;
  }
}

const IMAGE_PROMPT =
  "请提取图片中的所有文字（保持原文，不要翻译），然后另起一行用一句话描述图片内容。直接输出，不要客套话。用中文回答。";

/** Vision model text extraction + one-line description; returns null on any failure. */
export async function describeImage(env: Pick<Env, "AI">, bytes: Uint8Array): Promise<string | null> {
  if (!env.AI) return null;
  try {
    const out = (await env.AI.run(VISION_MODEL as Parameters<Ai["run"]>[0], {
      prompt: IMAGE_PROMPT,
      image: Array.from(bytes),
      max_tokens: 512,
    })) as { response?: string };
    const text = (out.response ?? "").trim();
    return text || null;
  } catch (err) {
    console.error("describeImage: failed", err);
    return null;
  }
}

/** Store the original media file in R2 (if bound) and record it in attachments. */
export async function storeOriginal(
  env: Env,
  userId: string,
  noteId: string,
  req: MediaIngestRequest
): Promise<string | null> {
  if (!env.MEDIA) return null;
  const safeName = (req.fileName || (req.type === "audio" ? "audio" : "image")).replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
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
