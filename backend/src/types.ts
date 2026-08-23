export type Env = {
  DB: D1Database;
  AI?: Ai;
  /** Optional Vectorize index; when absent semantic recall falls back to D1-stored vectors. */
  VECTORIZE?: VectorizeIndex;
  MEDIA?: R2Bucket;
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_BASE_URL: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
  /** Fallback model when the primary provider fails (default: Workers AI llama-3.3-70b); "none" disables the chain. */
  AI_FALLBACK_MODEL?: string;
  SUINIAN_ENC_KEY?: string;
  /** "false"/"0"/"off" disables /api/auth/register (default: enabled). */
  REGISTRATION_ENABLED?: string;
  /** Extra CORS origins, comma-separated; "*" allows any origin (self-host). */
  CORS_ALLOWED_ORIGINS?: string;
  /** Secret token guarding /api/admin/* maintenance endpoints; unset = endpoints disabled. */
  ADMIN_TOKEN?: string;
  /** 专用 bridge 心跳凭证（R194 P2-5）：/api/bridge/heartbeat 只认它或 ADMIN_TOKEN */
  BRIDGE_TOKEN?: string;
  /** VAPID keypair for Web Push (base64url); unset = push endpoints disabled. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** VAPID subject (mailto: or https:), defaults to mailto:admin@zalize.com. */
  VAPID_SUBJECT?: string;
  /** WeChat Official Account callback token; unset = /wechat/mp disabled (404). */
  WECHAT_MP_TOKEN?: string;
  /** WeChat Official Account AppID (safe-mode appid check + media download). */
  WECHAT_MP_APPID?: string;
  /** WeChat Official Account AppSecret (access_token for voice-media download). */
  WECHAT_MP_APPSECRET?: string;
  /** 43-char EncodingAESKey enabling safe (encrypted) callback mode. */
  WECHAT_MP_AES_KEY?: string;
  /** WeCom 微信客服 callback token; with AES key + corp id enables /wechat/kf. */
  WECOM_KF_TOKEN?: string;
  /** 43-char EncodingAESKey for the 微信客服 callback (always encrypted). */
  WECOM_KF_AES_KEY?: string;
  /** WeCom corp id (the AES envelope receiver id and gettoken corpid). */
  WECOM_CORP_ID?: string;
  /** 微信客服 secret (access_token for sync_msg / send_msg / media). */
  WECOM_KF_SECRET?: string;
};

export interface ThreadRow {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  note_count: number;
  updated_at: string;
  /** Newest fragment's created_at (list endpoint only). */
  last_note_at?: string | null;
  /** Oldest fragment's created_at (list endpoint only). */
  first_note_at?: string | null;
  /** Fragments added in the last 7 days (list endpoint only). */
  week_new_count?: number;
}

export type ReportPeriod = "week" | "month";

export interface WeeklyReportRow {
  id: string;
  user_id: string;
  week_start: string;
  period: ReportPeriod;
  content_md: string;
  created_at: string;
}

export type Category = "idea" | "todo" | "collect" | "data" | "expense" | "income" | "transfer";

export interface TriageResult {
  category: Category;
  tags: string[];
  title: string | null;
  is_sensitive: boolean;
  todo_due?: string | null;
  /** Amount for expense/income notes; null when the amount is uncertain. */
  amount?: number | null;
  /** ISO 4217 currency code (e.g. CNY, USD) for expense/income notes. */
  currency?: string | null;
  /** Optional merchant / purpose for expense/income notes. */
  merchant?: string | null;
  /** 内容像在向笔记库提问（即使没打问号）；前端据此展示「去问 AI」入口。 */
  is_question?: boolean;
}

/** Optional per-note metadata stored as JSON in notes.meta. */
export interface NoteMeta {
  /** Client-generated idempotency key for media re-uploads (outbox replays). */
  client_id?: string;
  /** Original Whisper transcript before LLM correction (audio notes). */
  raw_transcript?: string;
  /** Result of the last transcription/extraction attempt (voice/image notes). */
  media_status?: "ok" | "extract_failed";
  /** 转写低置信（R212 P2-1）：前端展示提示与纠错入口；用户编辑正文后清除。 */
  transcript_suspect?: boolean;
  /** whisper 平均 logprob（R214 P1-2）：低置信阈值的运维观测与后续标定依据。 */
  transcript_logprob?: number;
  /** 图片文字识别存疑（R212 P3-3）：前端提示核对原图；用户编辑正文后清除。 */
  ocr_suspect?: boolean;
  /** Full vision-model description (image notes). */
  image_description?: string;
  /** 视觉模型判定图片含机密值（image notes）：文本分拣看不到像素，复判不得据「正文无秘密值」解除敏感位。 */
  vision_sensitive?: boolean;
  /** Site name of the linked page (link notes). */
  link_site?: string;
  /** Extracted article text, first ~2k chars (link notes). */
  link_excerpt?: string;
  /** Result of the last article-extraction attempt (link notes). */
  link_status?: "ok" | "no_content" | "fetch_failed";
  /** 抓取失败归因（R221 P2-1）；null 用于 json_patch 清除旧值 */
  link_fail_reason?: "http_404" | "http_403" | "http_error" | "timeout" | "not_html" | "network" | null;
  /** ISO timestamp of the last article-extraction attempt (link notes). */
  link_fetched_at?: string;
  /** Original file name (file notes). */
  file_name?: string;
  /** Original file MIME type (file notes). */
  file_mime?: string;
  /** Original file size in bytes (file notes). */
  file_size?: number;
  /** Detected file kind: pdf / txt / md / docx (file notes). */
  file_kind?: string;
  /** Extracted full-text excerpt, first ~6k chars (long file notes). */
  file_excerpt?: string;
  /** Result of the text extraction attempt (file notes). */
  file_status?: "ok" | "extract_failed";
  /** Export source this note was imported from (imported notes). */
  import_source?: string;
  /** When the note entered the queue via batch import; lateness is measured from here, not the preserved created_at. */
  imported_at?: string;
  /** Original tags from the export file, merged back after AI triage (imported notes). */
  import_tags?: string[];
  /** 导入内容指纹（HMAC-SHA256）：敏感笔记落库后 content 只剩占位符，重复导入去重靠它。 */
  import_fp?: string;
  /** 指纹算法版本（缺省视同 1）：v1 = HMAC-SHA256(SUINIAN_ENC_KEY)，无密钥时 SHA-256。 */
  import_fp_v?: number;
  /** Merchant / purpose of an expense/income note. */
  finance_merchant?: string;
  /** Fields the user set by hand; AI triage / cron sweeps must not overwrite them. */
  manual_override?: { category?: boolean; tags?: boolean; todo_due?: boolean; title?: boolean; is_sensitive?: boolean };
  /** Note saved from an AI Q&A round (问答写回闭环). */
  from_ask?: boolean;
  /** Triage kept failing and the note got a fallback category; the cron sweep re-triages it once AI recovers. */
  needs_retriage?: boolean;
  /** Retriage retry counter maintained by the degrade sweep. */
  retriage_attempts?: number;
  /** Terminal state: retriage hit its attempt ceiling; cleared by a later successful triage or a manual category edit. */
  triage_failed?: boolean;
  /** 失败归因（R214 P1-1）：模型有响应但输出解析不出合法 JSON（对抗/注入内容的典型形态）。 */
  triage_parse_failed?: boolean;
  /** 分拣判定内容像在提问（无问号疑问句）；前端据此渲染「去问 AI」轻量入口。 */
  is_question?: boolean;
}

export interface NoteRow {
  id: string;
  user_id: string;
  source: string;
  raw_type: string;
  content: string;
  url: string | null;
  url_title: string | null;
  url_summary: string | null;
  url_titles: string | null;
  category: Category | null;
  tags: string;
  title: string | null;
  thread_id: string | null;
  is_sensitive: number;
  content_enc: string | null;
  todo_due: string | null;
  todo_done: number;
  done_at: string | null;
  amount: number | null;
  currency: string | null;
  meta: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
