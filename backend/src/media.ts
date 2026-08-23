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

/**
 * Delete R2 objects with one retry; final failures are recorded in
 * media_delete_failures for the cron to retry (R226 P1: the cascade paths used
 * to fire-and-forget with catch(console.error), silently leaking private
 * originals when a batch delete failed).
 */
export async function deleteMediaObjects(env: Pick<Env, "MEDIA" | "DB">, keys: string[]): Promise<void> {
  if (!env.MEDIA || keys.length === 0) return;
  try {
    await env.MEDIA.delete(keys);
    await verifyMediaDeleted(env, keys);
    return;
  } catch (e) {
    console.error("deleteMediaObjects: R2 delete failed, retrying once", e);
  }
  await new Promise((r) => setTimeout(r, 500));
  try {
    await env.MEDIA.delete(keys);
    await verifyMediaDeleted(env, keys);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`deleteMediaObjects: retry failed, recording ${keys.length} key(s) for cron retry`, e);
    for (let i = 0; i < keys.length; i += 40) {
      const chunk = keys.slice(i, i + 40);
      await env.DB.batch(
        chunk.map((k) =>
          env.DB
            .prepare(
              "INSERT INTO media_delete_failures (r2_key, last_error) VALUES (?, ?) ON CONFLICT(r2_key) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error"
            )
            .bind(k, msg.slice(0, 500))
        )
      );
    }
  }
}

/** 逐 key head 复核删除闭环（R228 P1，audit-r227 §1.1）：R2 批量 delete 理论上
 * 可能对个别 key 静默不生效（不抛错）——delete 返回成功不作为清理成功的证据，
 * 只有逐 key head 为 null 才算删净；仍存在的 key 记入 media_delete_failures
 * 交 cron 重试。verify 自身的瞬时错误只记日志不冒泡，绝不把复核失败误报成
 * 删除失败而触发整批重删。 */
async function verifyMediaDeleted(env: Pick<Env, "MEDIA" | "DB">, keys: string[]): Promise<void> {
  if (!env.MEDIA) return;
  const survivors: string[] = [];
  for (const k of keys) {
    try {
      if ((await env.MEDIA.head(k)) !== null) survivors.push(k);
    } catch (e) {
      console.error("verifyMediaDeleted: head failed (skipping verify for key)", k, e);
    }
  }
  if (survivors.length === 0) return;
  console.error(`verifyMediaDeleted: ${survivors.length} object(s) still present after delete, recording for cron retry`, survivors);
  for (let i = 0; i < survivors.length; i += 40) {
    const chunk = survivors.slice(i, i + 40);
    await env.DB.batch(
      chunk.map((k) =>
        env.DB
          .prepare(
            "INSERT INTO media_delete_failures (r2_key, last_error) VALUES (?, ?) ON CONFLICT(r2_key) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error"
          )
          .bind(k, "object still present after delete (silent failure)")
      )
    );
  }
}

/** Cron retry for recorded R2 delete failures; rows clear only on confirmed success. */
export async function flushMediaDeleteFailures(env: Pick<Env, "MEDIA" | "DB">): Promise<number> {
  if (!env.MEDIA) return 0;
  const { results } = await env.DB.prepare(
    "SELECT r2_key FROM media_delete_failures ORDER BY enqueued_at ASC LIMIT 200"
  ).all<{ r2_key: string }>();
  const keys = (results ?? []).map((r) => r.r2_key);
  if (keys.length === 0) return 0;
  try {
    await env.MEDIA.delete(keys);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`flushMediaDeleteFailures: retry of ${keys.length} key(s) failed`, e);
    const ph = keys.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE media_delete_failures SET attempts = attempts + 1, last_error = ? WHERE r2_key IN (${ph})`
    )
      .bind(msg.slice(0, 500), ...keys)
      .run();
    return 0;
  }
  // 只清除逐 key head 复核确认已删净的行（R228 P1）：delete 不抛错不等于删净，
  // 复核不过/head 出错的行留在表里等下轮 cron
  const cleared: string[] = [];
  for (const k of keys) {
    try {
      if ((await env.MEDIA.head(k)) === null) cleared.push(k);
    } catch (e) {
      console.error("flushMediaDeleteFailures: head verify failed, keeping row", k, e);
    }
  }
  if (cleared.length > 0) {
    const ph = cleared.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM media_delete_failures WHERE r2_key IN (${ph})`).bind(...cleared).run();
    console.warn(`flushMediaDeleteFailures: cleared ${cleared.length} previously-failed R2 delete(s)`);
  }
  const survivors = keys.filter((k) => !cleared.includes(k));
  if (survivors.length > 0) {
    const ph = survivors.map(() => "?").join(",");
    await env.DB.prepare(
      `UPDATE media_delete_failures SET attempts = attempts + 1, last_error = ? WHERE r2_key IN (${ph})`
    )
      .bind("object still present after delete (silent failure)", ...survivors)
      .run();
  }
  return cleared.length;
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
 * 敏感笔记的原件（R154 P2-2）以 AES-GCM 信封（SNE1 + IV + 密文）落 R2。
 * 竞态收口（R262 P1-1，audit-r261 §P1-1 根因之一）：异步分拣可能在「本函数
 * 读到 is_sensitive=0」与「明文 put 落地」之间把笔记转敏感——彼时分拣侧的
 * syncAttachmentEncryption 还看不到附件行，双方都以为无事可做，明文永久残留。
 * 因此明文写入后必须复读敏感位，命中则就地走同一加密闭环重写。
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
    // 明文落地后复读敏感位，堵「写入期间分拣转敏感」竞态窗口；失败落表绝不静默
    if (!encrypted && env.SUINIAN_ENC_KEY) {
      const after = await env.DB.prepare("SELECT is_sensitive FROM notes WHERE id = ?")
        .bind(noteId)
        .first<{ is_sensitive: number }>();
      if (after?.is_sensitive) {
        try {
          await encryptObjectVerified(
            { MEDIA: env.MEDIA, SUINIAN_ENC_KEY: env.SUINIAN_ENC_KEY },
            key,
            mime
          );
        } catch (err) {
          await recordEncryptFailure(env, noteId, key, err);
        }
      }
    }
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

const ENCRYPT_MAX_ATTEMPTS = 3;

/**
 * 单对象加密闭环（R262 P1-1）：读原件 → 已是 SNE1 信封则只补齐 enc 元数据 →
 * 否则加密重写 → put 后逐对象 head() 复核 customMetadata.enc（put 不抛错不等于
 * 写成功，与 R228 删除复核同一口径）。对象内重试至多 3 次，最终失败抛错由
 * 调用方落表，绝不静默。返回 "encrypted"（本次重写）/"already"（已加密）/
 * "missing"（对象不存在）。
 */
export async function encryptObjectVerified(
  env: { MEDIA?: R2Bucket; SUINIAN_ENC_KEY?: string },
  r2Key: string,
  mime: string | null
): Promise<"encrypted" | "already" | "missing"> {
  if (!env.MEDIA || !env.SUINIAN_ENC_KEY) throw new Error("media/enc-key unavailable");
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= ENCRYPT_MAX_ATTEMPTS; attempt++) {
    try {
      const obj = await env.MEDIA.get(r2Key);
      if (!obj) return "missing";
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (isEncryptedAttachment(bytes)) {
        if (obj.customMetadata?.enc === "1") return "already";
        // 存量手工加密对象缺 enc 元数据：补齐，让 head 口径与 magic 口径一致
        await env.MEDIA.put(r2Key, bytes, {
          httpMetadata: { contentType: obj.httpMetadata?.contentType || mime || "application/octet-stream" },
          customMetadata: { enc: "1" },
        });
      } else {
        const enc = await encryptBytes(env.SUINIAN_ENC_KEY, bytes);
        await env.MEDIA.put(r2Key, enc, {
          httpMetadata: { contentType: mime || obj.httpMetadata?.contentType || "application/octet-stream" },
          customMetadata: { enc: "1" },
        });
      }
      const head = await env.MEDIA.head(r2Key);
      if (head?.customMetadata?.enc === "1") return "encrypted";
      lastErr = new Error("head verify: enc metadata missing after put");
    } catch (err) {
      lastErr = err;
    }
    if (attempt < ENCRYPT_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 200 * attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** 加密失败落表（media_encrypt_failures），10 分钟 cron 重试；落表本身失败才降级为日志。 */
async function recordEncryptFailure(
  env: { DB: D1Database },
  noteId: string,
  r2Key: string,
  err: unknown
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`attachment encrypt failed, recording for cron retry note=${noteId} key=${r2Key}`, err);
  try {
    await env.DB.prepare(
      "INSERT INTO media_encrypt_failures (r2_key, note_id, last_error) VALUES (?, ?, ?) ON CONFLICT(r2_key) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error"
    )
      .bind(r2Key, noteId, msg.slice(0, 500))
      .run();
  } catch (e) {
    console.error("recordEncryptFailure: failed to persist", r2Key, e);
  }
}

/**
 * 笔记转敏感时的附件加密收口（异步分拣/手动标敏/媒体重试共用）：把该笔记
 * 名下仍为明文的 R2 原件逐对象走加密闭环（head() 复核加密态 + 对象内重试），
 * 单对象失败落 media_encrypt_failures 由 cron 重试并继续处理其余对象，
 * 杜绝静默失败（R262 P1-1）。幂等。
 */
export async function syncAttachmentEncryption(
  env: { MEDIA?: R2Bucket; DB: D1Database; SUINIAN_ENC_KEY?: string },
  noteId: string
): Promise<void> {
  if (!env.MEDIA || !env.SUINIAN_ENC_KEY) return;
  let rows: { r2_key: string; mime: string | null }[];
  try {
    const res = await env.DB.prepare("SELECT r2_key, mime FROM attachments WHERE note_id = ?")
      .bind(noteId)
      .all<{ r2_key: string; mime: string | null }>();
    rows = res.results ?? [];
  } catch (err) {
    console.error("syncAttachmentEncryption: attachments query failed", noteId, err);
    return;
  }
  for (const a of rows) {
    try {
      await encryptObjectVerified(env, a.r2_key, a.mime);
    } catch (err) {
      await recordEncryptFailure(env, noteId, a.r2_key, err);
    }
  }
}

/**
 * Cron retry for recorded attachment-encrypt failures (10-min cron, R262 P1-1):
 * rows clear only after head() 复核加密态；对象已删/笔记已转非敏感的行直接清。
 */
export async function flushMediaEncryptFailures(env: Env): Promise<number> {
  if (!env.MEDIA || !env.SUINIAN_ENC_KEY) return 0;
  const { results } = await env.DB.prepare(
    "SELECT r2_key, note_id FROM media_encrypt_failures ORDER BY enqueued_at ASC LIMIT 100"
  ).all<{ r2_key: string; note_id: string }>();
  let cleared = 0;
  for (const row of results ?? []) {
    try {
      const note = await env.DB.prepare("SELECT is_sensitive FROM notes WHERE id = ?")
        .bind(row.note_id)
        .first<{ is_sensitive: number }>();
      if (note && !note.is_sensitive) {
        // 笔记已转非敏感：无需加密，清行（明文由非敏感语义允许）
        await env.DB.prepare("DELETE FROM media_encrypt_failures WHERE r2_key = ?").bind(row.r2_key).run();
        cleared++;
        continue;
      }
      const state = await encryptObjectVerified(env, row.r2_key, null);
      await env.DB.prepare("DELETE FROM media_encrypt_failures WHERE r2_key = ?").bind(row.r2_key).run();
      cleared++;
      if (state !== "missing") console.warn(`flushMediaEncryptFailures: recovered ${row.r2_key} (${state})`);
    } catch (err) {
      await recordEncryptFailure(env, row.note_id, row.r2_key, err);
    }
  }
  return cleared;
}

/**
 * 存量敏感附件迁移 sweep（每日 cron）：把所有敏感笔记名下仍为明文的 R2 原件
 * 走加密闭环重写。已加密对象靠 customMetadata.enc 的 head 检查跳过（存量对象
 * 缺元数据时由闭环按 magic 兜底补齐），单对象失败落表重试并继续其余对象
 *（R262 P1-1：此前一个失败整批中止且静默）。幂等且限额，可反复运行直至清零。
 */
export async function sweepUnencryptedSensitiveAttachments(env: Env, limit = 100): Promise<number> {
  if (!env.MEDIA || !env.SUINIAN_ENC_KEY) return 0;
  let migrated = 0;
  let rows: { r2_key: string; mime: string | null; note_id: string }[];
  try {
    const res = await env.DB.prepare(
      "SELECT a.r2_key, a.mime, a.note_id FROM attachments a JOIN notes n ON a.note_id = n.id WHERE n.is_sensitive = 1 LIMIT ?"
    )
      .bind(limit)
      .all<{ r2_key: string; mime: string | null; note_id: string }>();
    rows = res.results ?? [];
  } catch (err) {
    console.error("sweepUnencryptedSensitiveAttachments: query failed", err);
    return 0;
  }
  for (const a of rows) {
    try {
      const head = await env.MEDIA.head(a.r2_key);
      if (!head || head.customMetadata?.enc === "1") continue;
      if ((await encryptObjectVerified(env, a.r2_key, a.mime)) === "encrypted") migrated++;
    } catch (err) {
      await recordEncryptFailure(env, a.note_id, a.r2_key, err);
    }
  }
  if (migrated > 0) console.warn(`sweepUnencryptedSensitiveAttachments: migrated ${migrated} object(s)`);
  return migrated;
}
