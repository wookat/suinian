import type { Env, NoteMeta } from "./types";
import { chatComplete, withTimeout } from "./ai";
import { detectSensitive } from "./triage";
import { encryptBytes, decryptBytes, isEncryptedAttachment } from "./crypto";

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

/** 扩展名 → mime 兜底表：仅收录客户端会内嵌渲染/播放的已知类型（R146 P2-1）。 */
const EXT_MIME: Record<string, string> = {
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  amr: "audio/amr",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
};

/**
 * Resolve the attachment mime at the single ingestion boundary (storeOriginal):
 * keep any explicit non-generic mime; otherwise infer from the file extension
 * (`webm` is ambiguous — resolved by the declared media type).
 */
export function resolveAttachmentMime(mime: string | null | undefined, fileName?: string | null, type?: MediaType): string {
  const m = (mime || "").trim();
  if (m && m.toLowerCase() !== "application/octet-stream") return m;
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(fileName || "")?.[1]?.toLowerCase();
  if (ext === "webm") return type === "audio" ? "audio/webm" : "video/webm";
  return (ext && EXT_MIME[ext]) || m || "application/octet-stream";
}

export function mediaTooLargeMessage(size: number): string {
  return `文件过大：最多 ${MAX_MEDIA_BYTES / 1024 / 1024}MB，当前约 ${(size / 1024 / 1024).toFixed(1)}MB。`;
}

/** Build the WeChat/web confirmation reply, e.g. 已记录（语音转写）：<前30字>；敏感笔记不回显内容。 */
export function buildMediaReply(type: MediaType, text: string, ok: boolean, sensitive = false): string {
  const label = type === "audio" ? "语音转写" : "图片识别";
  if (!ok) return `已记录（${label}失败，已存占位，稍后可重发）`;
  if (sensitive) return `已记录（${label}，含敏感内容已加密保存，可在时间流解锁查看）`;
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

/**
 * Whisper hallucinates canned closing phrases on (near-)silent audio
 * (R143 P2-3): a short transcript that is exactly one of these boilerplate
 * lines is treated as "no speech" rather than user content.
 */
const WHISPER_HALLUCINATION_RE =
  /^(thank you( for watching)?|thanks for watching|please subscribe.*|谢谢(大家|观看|收看)?|请不吝点赞.*|字幕制作.*|字幕by.*|amara\.org.*)[\s.。!！]*$/i;

// 纯噪音幻听扩充（R218 P2-2，audit-r217 §3）：白/粉噪音在生产被 whisper 幻听成
// 跨语种固定串（实测两例均为俄语 "Продолжение следует..."，logprob -0.2 级别、
// 置信信号并不低），再经 LLM 纠错变成一句看似正常的中文入库。已知幻觉串按
// 「无语音」确定性拦截，与纯静音同路径（诚实失败占位 + retry-media 可重试）。
const WHISPER_HALLUCINATION_I18N_RE =
  /^(продолжение следует|субтитры\s.*|редактор субтитров\s.*|спасибо за просмотр|ご視聴ありがとうございました|チャンネル登録.*お願い.*|字幕由\s?amara\.org.*|구독과 좋아요.*|시청해\s?주셔서 감사합니다|see you (in the )?next (video|time)|don'?t forget to (like and )?subscribe.*)[\s.。!！…]*$/i;

export function isWhisperHallucination(text: string): boolean {
  const t = text.trim();
  if (t.length <= 24 && WHISPER_HALLUCINATION_RE.test(t)) return true;
  return t.length <= 48 && WHISPER_HALLUCINATION_I18N_RE.test(t);
}

/**
 * whisper-large-v3-turbo 输出自带的解码质量信号（R214 P1-2，audit-r213 §3.1）：
 * segments[].avg_logprob / no_speech_prob / compression_ratio / temperature 与
 * transcription_info.language_probability。字段缺失时置 null（fail-open 不判存疑）。
 */
export interface WhisperQuality {
  avg_logprob: number | null;
  no_speech_prob: number | null;
  compression_ratio: number | null;
  temperature: number | null;
  language_probability: number | null;
}

interface WhisperSegment {
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  temperature?: number;
}

interface WhisperOutput {
  text?: string;
  segments?: WhisperSegment[];
  transcription_info?: { language_probability?: number };
}

function whisperQuality(out: WhisperOutput): WhisperQuality {
  const segs = Array.isArray(out.segments) ? out.segments : [];
  const nums = (pick: (s: WhisperSegment) => number | undefined) =>
    segs.map(pick).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const mean = (vs: number[]) => (vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null);
  const max = (vs: number[]) => (vs.length ? Math.max(...vs) : null);
  const langProb = out.transcription_info?.language_probability;
  return {
    avg_logprob: mean(nums((s) => s.avg_logprob)),
    no_speech_prob: max(nums((s) => s.no_speech_prob)),
    compression_ratio: max(nums((s) => s.compression_ratio)),
    temperature: max(nums((s) => s.temperature)),
    language_probability: typeof langProb === "number" && Number.isFinite(langProb) ? langProb : null,
  };
}

// R214 P1-2 阈值：用真实错误形态样本对 @cf/openai/whisper-large-v3-turbo 实测标定
//（清晰/混响/快语速/电话带宽/轻噪 11 条正常样本 avg_logprob 全部 ≥ -0.23；
// 词义跑偏 -0.48、流利但完全错意 -0.62、噪声幻听 -0.81、倒放 -0.83、纯噪声
// -0.95——实质错误与正常之间有清晰间隔）。-0.35 取分离带中点，两侧都有余量。
// 其余为 whisper 生态通行的解码失败信号：温度回退（贪心解码失败被迫采样）、
// 压缩比过高（循环重复幻觉）、no_speech 高但仍有文本、语种判定不确定。
export const WHISPER_LOGPROB_SUSPECT = -0.35;
export const WHISPER_TEMPERATURE_SUSPECT = 0.5;
export const WHISPER_COMPRESSION_SUSPECT = 2.4;
export const WHISPER_NO_SPEECH_SUSPECT = 0.6;
export const WHISPER_LANG_PROB_SUSPECT = 0.6;

/** 转写模型自身的低置信判定（R214 P1-2）：任一信号命中即存疑；字段缺失不判。 */
export function isWhisperLowConfidence(q: WhisperQuality | null | undefined): boolean {
  if (!q) return false;
  if (q.avg_logprob !== null && q.avg_logprob < WHISPER_LOGPROB_SUSPECT) return true;
  if (q.temperature !== null && q.temperature >= WHISPER_TEMPERATURE_SUSPECT) return true;
  if (q.compression_ratio !== null && q.compression_ratio > WHISPER_COMPRESSION_SUSPECT) return true;
  if (q.no_speech_prob !== null && q.no_speech_prob > WHISPER_NO_SPEECH_SUSPECT) return true;
  if (q.language_probability !== null && q.language_probability < WHISPER_LANG_PROB_SUSPECT) return true;
  return false;
}

/** Whisper transcription via Workers AI; returns null on any failure. */
export async function transcribeAudio(
  env: Pick<Env, "AI">,
  bytes: Uint8Array
): Promise<{ text: string; quality: WhisperQuality } | null> {
  if (!env.AI) return null;
  try {
    const out = (await withTimeout(
      env.AI.run(WHISPER_MODEL as Parameters<Ai["run"]>[0], {
        audio: bytesToBase64(bytes),
      }) as Promise<WhisperOutput>,
      AI_RUN_TIMEOUT_MS,
      "whisper"
    )) as WhisperOutput;
    const text = (out.text ?? "").trim();
    if (isWhisperHallucination(text)) {
      console.warn("transcribeAudio: hallucinated boilerplate on silent audio, dropping", text);
      return null;
    }
    return text ? { text, quality: whisperQuality(out) } : null;
  } catch (err) {
    console.error("transcribeAudio: failed", err);
    return null;
  }
}

const CORRECT_SYSTEM_PROMPT =
  "你是语音转写纠错助手。修正下面转写文本中的同音错别字与明显断句错误，不改变原意，不增删信息。输出两行：第一行只输出「可信」或「存疑」——转写整体语义混乱、前后不连贯、像是把发音相近的词强行拼凑（无法自信恢复原意）时输出「存疑」，否则输出「可信」；第二行起输出纠正后的纯文本（不要解释，不要 markdown）。";

// 首行置信标记（容忍标点/括号包裹）；模型不遵循格式时 fail-open 按可信处理
const CORRECT_FLAG_RE = /^\s*[「《【\[(（<]*\s*(可信|存疑)\s*[」》】\])）>]*\s*[.。!！:：]?\s*(?:\r?\n|$)/;

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
): Promise<{ text: string; suspect: boolean }> {
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
    const full = (out ?? "").trim();
    const flag = full.match(CORRECT_FLAG_RE);
    const suspect = flag?.[1] === "存疑";
    const text = (flag ? full.slice(flag[0].length) : full).trim();
    if (!text || isCorrectionRefusal(text, raw)) return { text: raw, suspect };
    return { text, suspect };
  } catch (err) {
    console.error("correctTranscript: failed", err);
    return { text: raw, suspect: false };
  }
}

// ---- 转写质量启发式信号（R212 P2-1，audit-r211：严重错转写静默入库）----
// 确定性信号与纠错模型的语义自评取并集：任一命中只打存疑标记，绝不拦截入库。

const TRANSCRIPT_OK_CHAR_RE = /[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9\s，。！？、；：“”‘’《》（）「」【】…—·,.!?;:'"()\[\]%\-+/@#$¥％&*=_~。]/;

/** 乱码率：常见中英数字标点之外的字符占比。 */
export function garbledRatio(text: string): number {
  const chars = [...text];
  if (chars.length === 0) return 0;
  const bad = chars.filter((ch) => !TRANSCRIPT_OK_CHAR_RE.test(ch)).length;
  return bad / chars.length;
}

/** 字符 bigram Dice 相似度：纠错前后差异过大＝原转写不可靠。 */
export function bigramSimilarity(a: string, b: string): number {
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let inter = 0;
  let total = 0;
  for (const [, n] of ga) total += n;
  for (const [, n] of gb) total += n;
  if (total === 0) return 1;
  for (const [g, n] of ga) inter += Math.min(n, gb.get(g) ?? 0);
  return (2 * inter) / total;
}

/**
 * 启发式转写质量评估：乱码率异常、同一片段循环重复（whisper 常见幻觉形态）、
 * 纠错改动过大、长音频几乎无文字，任一命中即存疑。阈值故意保守，
 * 正常转写绝不误伤（存疑只加提示，不拦截入库）。
 */
export function isTranscriptSuspectHeuristic(raw: string, corrected: string, audioBytes?: number): boolean {
  const t = corrected.trim();
  if (t.length >= 6 && garbledRatio(t) > 0.15) return true;
  if (/(.{2,8})\1{3,}/.test(t)) return true;
  if (raw.trim().length >= 12 && bigramSimilarity(raw.trim(), t) < 0.45) return true;
  if (audioBytes !== undefined && audioBytes > 100_000 && t.length < 5) return true;
  return false;
}

export interface TranscriptionResult {
  /** 纠错后的最终文本（入库正文）。 */
  content: string;
  /** 原始 whisper 转写（与 content 不同时存 meta.raw_transcript）。 */
  raw: string;
  /** 低置信：前端据此展示提示与纠错入口，不影响入库。 */
  suspect: boolean;
  /** whisper 平均 logprob（存 meta.transcript_logprob，供运维/后续标定观测）。 */
  logprob: number | null;
}

/**
 * 四个语音入口（web/API、微信、企微、失败重试）共用的转写+纠错+质量评估
 * 入口：转写失败返回 null（调用方落占位符）；成功时附低置信判定，
 * 绝不因低置信拦截正常转写。
 */
export async function transcribeAndCorrect(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  bytes: Uint8Array
): Promise<TranscriptionResult | null> {
  const t = await transcribeAudio(env, bytes);
  if (t === null) return null;
  const raw = t.text;
  const { text, suspect: llmSuspect } = await correctTranscript(env, raw);
  // 三路取并集（R214 P1-2）：转写模型自身置信（抓「流利但错意」——字符级
  // 启发式与纠错自评在 audit-r213 实测 4/4 漏判的形态）∪ 字符级启发式 ∪
  // 纠错模型语义自评。任一命中只打存疑标记，绝不拦截入库。
  const suspect =
    isWhisperLowConfidence(t.quality) || llmSuspect || isTranscriptSuspectHeuristic(raw, text, bytes.length);
  return { content: text, raw, suspect, logprob: t.quality.avg_logprob };
}

// R188 P1-1/P2-1：文字段要求逐字完整转录（含密码/密钥等凭证值——这是用户
// 自己拍照存档的资料，省略或打码会让「拍照存密码」永远找不回；含品名与
// 合计行——丢失合计语义会导致金额双计）；新增敏感段让唯一能看到像素的
// 视觉模型给出敏感判定，作为文本敏感管道的输入（不是平行管道）。
const IMAGE_PROMPT =
  "你会看到一张图片。请按下面格式输出三部分，用中文回答，不要客套话，不要 markdown 格式（不要星号、井号）：\n" +
  "文字：<图片中的所有文字，逐行逐字完整转录，保持原文不要翻译。这是用户本人拍照存档的自己的资料，密码、密钥、账号、验证码、金额、合计等所有值都必须原样保留，绝不要省略、打码或用占位符代替。密码/密钥/账号这类连续字符串要逐字符保真：完整抄在同一行内，不要在中间换行或增删字符，注意区分形近字符（0 与 O、1 与 l、大小写）；普通文字也要照抄原字，不确定的字按最接近的原样输出，不要改写成同音字或形近字；若图中没有文字则输出「无」>\n" +
  "描述：<用一到两句话简洁描述图片内容，不要逐句重复图中文字>\n" +
  "敏感：<是/否——图中是否出现真实机密的具体值（密码/密钥/API key/token/验证码的具体值、完整身份证号、银行卡号）。只讨论概念或无具体值时输出「否」；「口令/暗号」后面跟的若只是会议室、房间号、地点、日常安排这类非机密内容，也输出「否」>\n" +
  "清晰：<是/否——图中文字是否全部清晰可辨认。存在模糊、遮挡、截断、手写潦草或你对个别字的识别没有把握时输出「否」；图中无文字或全部清晰时输出「是」>";

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
  /** 图片含机密值（视觉模型判定 ∪ 文本敏感检测），作为敏感管道的入口提示。 */
  sensitive: boolean;
  /** 文字识别存疑（R212 P3-3）：视觉模型自评「清晰：否」，前端据此提示核对原图。 */
  suspect?: boolean;
}

/** 视觉判定含凭证但文字段未见凭证值时，正文附加的如实标注（不含任何秘密值）。 */
export const IMAGE_CREDENTIAL_GAP_NOTICE = "（图中含密码/凭证类信息，文字可能未完整提取，可打开原图查看）";

/** Parse the three-section vision output into content (text-first) + description + sensitive. */
export function parseImageExtraction(raw: string): ImageExtraction {
  const cleaned = stripMarkdown(raw);
  const textMatch = cleaned.match(/(?:^|\n)\s*文字[:：]\s*([\s\S]*?)(?=\n\s*(?:描述|敏感|清晰)[:：]|$)/);
  const descMatch = cleaned.match(/(?:^|\n)\s*描述[:：]\s*([\s\S]*?)(?=\n\s*(?:敏感|清晰)[:：]|$)/);
  const flagMatch = cleaned.match(/(?:^|\n)\s*敏感[:：]\s*[<《【「(（\[]*\s*(是|否|yes|no)/i);
  const visionSensitive = /^(是|yes)$/i.test(flagMatch?.[1] ?? "");
  // 清晰段缺失或非「否」时 fail-open 按清晰处理（存疑只加提示，绝不影响入库）
  const clarityMatch = cleaned.match(/(?:^|\n)\s*清晰[:：]\s*[<《【「(（\[]*\s*(是|否|yes|no)/i);
  const suspect = /^(否|no)$/i.test(clarityMatch?.[1] ?? "");
  const text = (textMatch?.[1] ?? "").trim();
  const desc = (descMatch?.[1] ?? "").trim();
  // models often echo the prompt's angle-bracket placeholder (e.g. "<无>");
  // strip wrapping brackets before deciding whether the image really has text
  const bare = text.replace(/^[<《【「(（\[]+/, "").replace(/[>》】」)）\]]+$/, "").trim();
  const hasText = bare.length > 0 && !/^(无|没有|无文字|N\/A|none)。?$/i.test(bare);
  const finalize = (content: string, description: string): ImageExtraction => {
    // 敏感口径与文本管道同源：视觉判定 ∪ detectSensitive（正文/描述）。
    // 视觉说有凭证但文字段没抽出值（detectSensitive 不命中）＝R187 P1-1 的
    // 静默丢值场景：正文如实标注「值未提取，请查看原图」，绝不假装已保存
    const sensitive = visionSensitive || detectSensitive(content) || detectSensitive(description);
    if (visionSensitive && !detectSensitive(content) && !content.includes(IMAGE_CREDENTIAL_GAP_NOTICE)) {
      return { content: `${content}\n${IMAGE_CREDENTIAL_GAP_NOTICE}`, description, sensitive, suspect };
    }
    return { content, description, sensitive, suspect };
  };
  if (hasText) return finalize(bare, desc || cleaned);
  // no text in image: fall back to the first sentence of the description;
  // the fallback itself may be a bracketed placeholder too ("<无>" as the
  // whole output) — never surface it as note content
  const fallback = desc || cleaned;
  const bareFallback = fallback.replace(/^[<《【「(（\[]+/, "").replace(/[>》】」)）\]]+$/, "").trim();
  if (bareFallback.length === 0 || /^(无|没有|无文字|N\/A|none)。?$/i.test(bareFallback)) {
    return finalize("（图片，未识别出文字内容）", "");
  }
  const firstSentence = bareFallback.split(/(?<=[。！？!?])/)[0]?.trim() || bareFallback;
  return finalize(firstSentence, bareFallback);
}

/**
 * 视觉抽取结果 → 笔记字段的唯一映射（四个图片入口共用，杜绝口径漂移）：
 * description 进 meta；敏感判定同时作为入库闸门提示（is_sensitive）与
 * meta.vision_sensitive 粘性标记——文本分拣模型看不到像素，不能凭「正文无
 * 秘密值」推翻视觉判定（applyTriage 据此保持敏感位）。
 */
export function imageNoteFields(extraction: ImageExtraction): {
  content: string;
  meta: NoteMeta | null;
  is_sensitive: boolean;
} {
  let meta: NoteMeta | null = null;
  if (extraction.description && extraction.description !== extraction.content) {
    meta = { image_description: extraction.description };
  }
  if (extraction.sensitive) meta = { ...(meta ?? {}), vision_sensitive: true };
  if (extraction.suspect) meta = { ...(meta ?? {}), ocr_suspect: true };
  return { content: extraction.content, meta, is_sensitive: extraction.sensitive };
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
        // 转录任务要确定性输出：降低采样温度收敛同图多次抽取的差异（R187 观察 3.2）
        temperature: 0.1,
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

/**
 * Store the original media file in R2 (if bound) and record it in attachments.
 * 敏感笔记的原件（R154 P2-2）以 AES-GCM 信封（SNE1 + IV + 密文）落 R2；
 * 分拣异步转敏感的窗口由 syncAttachmentEncryption 收口。
 */
export async function storeOriginal(
  env: { MEDIA?: R2Bucket; DB: D1Database; SUINIAN_ENC_KEY?: string },
  userId: string,
  noteId: string,
  req: MediaIngestRequest
): Promise<string | null> {
  if (!env.MEDIA) return null;
  const safeName = (req.fileName || req.type).replace(/[^\w.\-\u4e00-\u9fff]/g, "_");
  const key = `media/${userId}/${noteId}/${Date.now()}-${safeName}`;
  const mime = resolveAttachmentMime(req.mime, req.fileName, req.type);
  try {
    let body: Uint8Array = req.bytes;
    let encrypted = false;
    if (env.SUINIAN_ENC_KEY) {
      const row = await env.DB.prepare("SELECT is_sensitive FROM notes WHERE id = ?")
        .bind(noteId)
        .first<{ is_sensitive: number }>();
      if (row?.is_sensitive) {
        body = await encryptBytes(env.SUINIAN_ENC_KEY, req.bytes);
        encrypted = true;
      }
    }
    await env.MEDIA.put(key, body, {
      httpMetadata: { contentType: mime },
      ...(encrypted ? { customMetadata: { enc: "1" } } : {}),
    });
    await env.DB.prepare("INSERT INTO attachments (id, note_id, r2_key, mime, size) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), noteId, key, mime, req.bytes.length)
      .run();
    return key;
  } catch (err) {
    console.error("storeOriginal: failed", err);
    return null;
  }
}

/**
 * 读取附件原件字节：按 SNE1 magic 自动识别加密信封并解密；明文存量对象原样
 * 返回。加密对象在无密钥/密钥不符时返回 null（fail-closed，不吐密文）。
 */
export async function loadOriginal(env: Env, r2Key: string): Promise<Uint8Array | null> {
  if (!env.MEDIA) return null;
  const obj = await env.MEDIA.get(r2Key);
  if (!obj) return null;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (!isEncryptedAttachment(bytes)) return bytes;
  if (!env.SUINIAN_ENC_KEY) return null;
  return decryptBytes(env.SUINIAN_ENC_KEY, bytes);
}

/**
 * 笔记转敏感时的附件加密收口（异步分拣/手动标敏/媒体重试共用）：把该笔记
 * 名下仍为明文的 R2 原件就地重写为加密信封。幂等，失败只记日志（下一次
 * 日常 sweep 兜底）。
 */
export async function syncAttachmentEncryption(
  env: { MEDIA?: R2Bucket; DB: D1Database; SUINIAN_ENC_KEY?: string },
  noteId: string
): Promise<void> {
  if (!env.MEDIA || !env.SUINIAN_ENC_KEY) return;
  try {
    const rows = await env.DB.prepare("SELECT r2_key, mime FROM attachments WHERE note_id = ?")
      .bind(noteId)
      .all<{ r2_key: string; mime: string | null }>();
    for (const a of rows.results ?? []) {
      const obj = await env.MEDIA.get(a.r2_key);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (isEncryptedAttachment(bytes)) continue;
      const enc = await encryptBytes(env.SUINIAN_ENC_KEY, bytes);
      await env.MEDIA.put(a.r2_key, enc, {
        httpMetadata: { contentType: a.mime || "application/octet-stream" },
        customMetadata: { enc: "1" },
      });
    }
  } catch (err) {
    console.error("syncAttachmentEncryption: failed", noteId, err);
  }
}

/**
 * 存量敏感附件迁移 sweep（每日 cron）：把所有敏感笔记名下仍为明文的 R2 原件
 * 加密重写。已加密对象靠 customMetadata.enc 的 head 检查跳过（存量手工对象
 * 兜底看 magic），幂等且限额，可反复运行直至清零。
 */
export async function sweepUnencryptedSensitiveAttachments(env: Env, limit = 100): Promise<number> {
  if (!env.MEDIA || !env.SUINIAN_ENC_KEY) return 0;
  let migrated = 0;
  try {
    const rows = await env.DB.prepare(
      "SELECT a.r2_key, a.mime, a.note_id FROM attachments a JOIN notes n ON a.note_id = n.id WHERE n.is_sensitive = 1 LIMIT ?"
    )
      .bind(limit)
      .all<{ r2_key: string; mime: string | null; note_id: string }>();
    for (const a of rows.results ?? []) {
      const head = await env.MEDIA.head(a.r2_key);
      if (!head || head.customMetadata?.enc === "1") continue;
      const obj = await env.MEDIA.get(a.r2_key);
      if (!obj) continue;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (isEncryptedAttachment(bytes)) continue;
      const enc = await encryptBytes(env.SUINIAN_ENC_KEY, bytes);
      await env.MEDIA.put(a.r2_key, enc, {
        httpMetadata: { contentType: a.mime || "application/octet-stream" },
        customMetadata: { enc: "1" },
      });
      migrated++;
    }
    if (migrated > 0) console.warn(`sweepUnencryptedSensitiveAttachments: migrated ${migrated} object(s)`);
  } catch (err) {
    console.error("sweepUnencryptedSensitiveAttachments: failed", err);
  }
  return migrated;
}
