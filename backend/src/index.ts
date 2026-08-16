import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import type { Env, NoteMeta, NoteRow, ThreadRow, TriageResult, WeeklyReportRow } from "./types";
import { triageNote, loadTopTags, loadCategoryCorrections, normalizeTodoDue, detectSensitive, maybeSensitive, sanitizeSensitiveTags, isValidTimezone, loadUserTz, zonedDate, DEFAULT_TZ, FALLBACK_TRIAGE } from "./triage";
import { extractUrl, extractUrls, fetchLinkMeta } from "./linkmeta";
import { encryptContent, decryptContent, ENC_PLACEHOLDER } from "./crypto";
import {
  parseNoteMeta,
  prepareNoteInsert,
  applyNotePatch,
  replaceNoteContent,
  applyTriage,
  setNoteAiTitle,
  prepareTagsUpdate,
} from "./note-store";
export { applyTriage } from "./note-store";
import { scrubDerivedMeta } from "./ingest";
import { encodeCursor, decodeCursor } from "./cursor";
import { enrichLinkInto, backfillLinkExtracts } from "./extract";
import { clusterNote, refreshThreads, reconcileThreads, mergeDuplicateThreads, sweepRecentDuplicateThreads } from "./threads";
import {
  createRebuildJob,
  getActiveThreadJob,
  getThreadJob,
  runRebuildJobSlice,
  resumeThreadJobs,
  backfillThreadClusters,
  resetThreadBackfill,
  REBUILD_SLICE_BUDGET_MS,
  type ThreadJobRow,
} from "./thread-jobs";
import { chatComplete, aiProbe } from "./ai";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  validateName,
  validatePassword,
  generateRecoveryCode,
  normalizeRecoveryCode,
  registrationEnabled,
  checkRateLimit,
  sweepAuthRateLimits,
  clientIp,
} from "./auth";
import { generatePeriodReport, generateAllWeeklyReports, generateAllMonthlyReports, financeStats } from "./reports";
import { getTodayReview, generateAllDailyReviews, readCronHeartbeats, writeCronHeartbeat } from "./review";
import { upsertNoteEmbedding, deleteNoteEmbedding, deleteNoteEmbeddings, semanticRecall, backfillEmbeddings, EMBED_BACKFILL_BUDGET_MS } from "./semantic";
import { extractGraph, deleteNoteGraph, deleteNotesGraph, getThreadGraph, graphExpand, backfillGraphExtracts } from "./graph";
import { deleteUserData } from "./account";
import {
  parseMediaRequest,
  transcribeAudio,
  correctTranscript,
  describeImage,
  storeOriginal,
  buildMediaReply,
  reconcileMediaOrphans,
  AUDIO_FAILED_PLACEHOLDER,
  IMAGE_FAILED_PLACEHOLDER,
} from "./media";
import { detectFileKind, buildFileNote, buildFileReply, FILE_FAILED_PLACEHOLDER } from "./files";
import { parseImportFile, runImport, IMPORT_SOURCES, ZIP_IMPORT_SOURCES, MAX_IMPORT_ITEMS, type ImportSource, type ImportItem, type ImportFailure } from "./import";
import { parseImportZip, type ZipImportSource } from "./import-zip";
import { registerMcpRoute } from "./mcp";
import { buildBackupZip, restoreBackup, MAX_RESTORE_BYTES } from "./backup";
import { parseTimeRange, inTimeRange, isRefusalAnswer, buildNoAnswerResponse, reconcileAskCitations, sensitiveHintLine, financeAggIntent, buildFinanceAggAnswer, buildFinanceFailClosedAnswer, countQueryIntent, buildCountAnswer, buildCountFailClosedAnswer, buildScopedCountAnswer, buildAvgPerDayAnswer, COUNT_SCOPE_LABELS, extremeQueryIntent, buildExtremeAnswer, enumListIntent, topicEnumIntent, classifyAskIntent, mediaTypeIntent, financeClarifyTerms, buildFinanceClarifyAnswer, FINANCE_WORD_RE, CREDENTIAL_Q_RE, credentialHintLine, financeExtremeIntent, buildFinanceExtremeAnswer, topicCountIntent, buildTopicCountAnswer, financeTopicTerms, buildFinanceSubsetAnswer, askTopicTerms, noteHitsTopic, ASK_CITATION_MIN_SCORE, ASK_SUGGESTION_MIN_SCORE, MULTI_HOP_RE } from "./ask";
import { pushConfigured, sendPushToUser, userSubscriptions, sweepTodoReminders, sweepDailyReviewPush } from "./push";
import {
  PIPELINE_TIMEOUT_MS,
  SENSITIVE_EXPORT_PLACEHOLDER,
  SOFT_DELETE_RETENTION_DAYS,
  RETRIAGE_TIME_BUDGET_MS,
  TRIAGE_DEGRADE_AFTER_MS,
  NOTE_WRITE_RATE_LIMIT_MAX,
  BULK_INGEST_RATE_LIMIT_MAX,
  BATCH_WRITE_RATE_LIMIT_MAX,
  THREAD_REBUILD_RATE_LIMIT_MAX,
} from "./constants";
import { buildStats, normalizeTzOffset, SAMPLE_TAG_LIKE } from "./stats";
import {
  verifySignature,
  verifyMsgSignature,
  decryptWechatMessage,
  encryptWechatMessage,
  buildEncryptedReply,
  parseWechatXml,
  buildTextReply,
  createBindCode,
  consumeBindCode,
  lookupBinding,
  extractBindCode,
  downloadMpMedia,
  BIND_CODE_TTL_MINUTES,
} from "./wechat-mp";
import {
  wecomKfConfigured,
  parseWecomKfCallback,
  syncKfMessages,
  sendKfText,
  downloadWecomMedia,
  consumeBindCodeKf,
  lookupKfBinding,
  type KfMessage,
} from "./wecom-kf";

type Vars = { userId: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const ALLOWED_ORIGINS = [
  "https://suinian.zalize.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
];

/**
 * Origins allowed for CORS: the built-in list plus CORS_ALLOWED_ORIGINS
 * (comma-separated; "*" allows any origin). The API is bearer-token only (no
 * cookies), so self-hosters can safely add their own Pages/custom domain here.
 */
function corsOrigin(origin: string, extra: string | undefined): string | null {
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  for (const o of (extra ?? "").split(",")) {
    const t = o.trim();
    if (t === "*" || t === origin) return origin;
  }
  return null;
}

app.use(
  "*",
  cors({
    origin: (origin, c) => corsOrigin(origin, (c.env as Env).CORS_ALLOWED_ORIGINS),
    allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    maxAge: 86400,
  })
);

// security response headers on every API response
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  c.res.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "no-referrer");
});

app.onError((err, c) => {
  console.error("unhandled error:", c.req.method, c.req.path, err instanceof Error ? (err.stack ?? err.message) : err);
  // ask failures get a readable, retryable message instead of a bare "internal error"
  if (c.req.path === "/api/ask")
    return c.json({ error: "问答服务暂时不可用，请稍后重试", retryable: true }, 503);
  return c.json({ error: "internal error" }, 500);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

const MAX_CONTENT_CHARS = 20_000;

/** Per-user /api/ask requests per minute (each runs several LLM calls). */
const ASK_RATE_LIMIT_MAX = 15;

/** Backoff schedule for in-request triage retries (async path); each delay gets up to +100% jitter. */
const TRIAGE_RETRY_DELAYS_MS = [3_000, 8_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function contentTooLong(c: { json: (o: object, s: 413) => Response }, content: string): Response | null {
  if (content.length <= MAX_CONTENT_CHARS) return null;
  return c.json(
    { error: `内容过长：最多 ${MAX_CONTENT_CHARS} 字符，当前 ${content.length} 字符。请拆成多条或精简后再发。` },
    413
  );
}

// bridge reports every ~60s; beyond this the process is presumed dead
const BRIDGE_HEARTBEAT_STALE_MS = 5 * 60 * 1000;
const BRIDGE_STATUSES = new Set(["online", "waiting_scan", "starting"]);

app.get("/", (c) => c.json({ name: "suinian-api", status: "ok" }));
app.get("/health", async (c) => {
  // ?probe=ai runs one tiny completion through the provider chain. provider
  // 报告的是链位而非服务质量：fallback=Workers AI 是当前主力基线（DeepSeek 未
  // 充值期间的常态），不是降级——外部告警只看 ok:false（R134 口径）
  if (c.req.query("probe") === "ai") {
    const ai = await aiProbe(c.env);
    return c.json({ ok: true, ai }, ai.ok ? 200 : 503);
  }
  // ?probe=bridge reports the WeChat bridge state from its heartbeat so external
  // monitoring sees the real login state (online / waiting_scan / stale) instead
  // of just "the process is running"
  if (c.req.query("probe") === "bridge") {
    const hb = (await readCronHeartbeats(c.env, ["wechat_bridge"]))[0];
    let stats: { status?: string; detail?: string } = {};
    try {
      stats = hb?.stats ? (JSON.parse(hb.stats) as typeof stats) : {};
    } catch {
      /* keep empty */
    }
    const ageMs = hb ? Date.now() - Date.parse(hb.last_run_at.replace(" ", "T") + "Z") : null;
    const stale = ageMs === null || !Number.isFinite(ageMs) || ageMs > BRIDGE_HEARTBEAT_STALE_MS;
    const status = hb ? (stale ? "stale" : (stats.status ?? "unknown")) : "never_reported";
    const ok = status === "online";
    return c.json(
      { ok, bridge: { status, last_seen_at: hb?.last_run_at ?? null, detail: stats.detail ?? null } },
      ok ? 200 : 503
    );
  }
  return c.json({ ok: true });
});

// ---- public auth: register / login (mounted before the bearer middleware) ----
app.post("/api/auth/register", async (c) => {
  if (!registrationEnabled(c.env.REGISTRATION_ENABLED)) {
    return c.json({ error: "注册已关闭" }, 403);
  }
  const body = await c.req.json<{ name?: unknown; password?: unknown }>().catch(() => null);
  const name = validateName(body?.name);
  if (!(await checkRateLimit(c.env.DB, "register", name ? [clientIp(c.req.raw), `acct:${name}`] : [clientIp(c.req.raw)]))) {
    return c.json({ error: "操作过于频繁，请一分钟后再试" }, 429);
  }
  if (!name) return c.json({ error: "用户名需 2-32 个字符（中英文、数字、._-[]）" }, 400);
  const password = validatePassword(body?.password);
  if (!password) return c.json({ error: "密码需 8-128 个字符" }, 400);
  const started = Date.now();
  const existing = await c.env.DB.prepare("SELECT id, name, api_token, password_hash FROM users WHERE name = ?")
    .bind(name)
    .first<{ id: string; name: string; api_token: string; password_hash: string | null }>();
  if (existing) {
    // idempotent retry: a previous attempt may have created the account but the
    // response never reached the client — same name + same password returns the
    // existing account instead of a dead-end 409
    if (existing.password_hash && (await verifyPassword(password, existing.password_hash))) {
      console.log(`register: idempotent retry for ${existing.id}`);
      return c.json({ user: { id: existing.id, name: existing.name }, api_token: existing.api_token });
    }
    return c.json({ error: "用户名已存在", code: "NAME_TAKEN" }, 409);
  }
  const id = `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const token = generateToken();
  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (e) {
    console.error("register: hashPassword failed", e);
    return c.json({ error: "注册失败（密码处理出错），请重试", code: "HASH_FAILED" }, 500);
  }
  try {
    // single INSERT = atomic in D1; the account only exists once this succeeds
    await c.env.DB.prepare("INSERT INTO users (id, name, api_token, password_hash) VALUES (?, ?, ?, ?)")
      .bind(id, name, token, passwordHash)
      .run();
  } catch (e) {
    console.error("register: insert failed", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg)) {
      // 并发同名注册被唯一索引拦住（R120 P1-2）：同密码的并发重试仍返回
      // 已建账号（与上方幂等重试同一语义），其它一律 409
      const winner = await c.env.DB.prepare("SELECT id, name, api_token, password_hash FROM users WHERE name = ?")
        .bind(name)
        .first<{ id: string; name: string; api_token: string; password_hash: string | null }>();
      if (winner?.password_hash && (await verifyPassword(password, winner.password_hash))) {
        return c.json({ user: { id: winner.id, name: winner.name }, api_token: winner.api_token });
      }
      return c.json({ error: "用户名已存在", code: "NAME_TAKEN" }, 409);
    }
    return c.json({ error: "注册失败（数据库写入出错），请重试", code: "DB_WRITE_FAILED" }, 500);
  }
  console.log(`register: created ${id} in ${Date.now() - started}ms`);
  // one-time recovery code (R144 P1-2): shown to the user exactly once here;
  // only its hash is stored. Failure to set it never fails registration.
  let recoveryCode: string | null = null;
  try {
    recoveryCode = generateRecoveryCode();
    const rh = await hashPassword(normalizeRecoveryCode(recoveryCode)!);
    await c.env.DB.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?").bind(rh, id).run();
  } catch (e) {
    console.error("register: recovery code setup failed", e);
    recoveryCode = null;
  }
  return c.json({ user: { id, name }, api_token: token, recovery_code: recoveryCode }, 201);
});

// ---- POST /api/auth/recover (public) ----
// Passwordless account recovery: name + one-time recovery code -> set a new
// password. On success the code is consumed, the API token is rotated (a
// leaked token dies with the old password) and a fresh code is returned.
app.post("/api/auth/recover", async (c) => {
  const body = await c.req
    .json<{ name?: unknown; recovery_code?: unknown; new_password?: unknown }>()
    .catch(() => null);
  const name = validateName(body?.name);
  if (!(await checkRateLimit(c.env.DB, "recover", name ? [clientIp(c.req.raw), `acct:${name}`] : [clientIp(c.req.raw)]))) {
    return c.json({ error: "操作过于频繁，请一分钟后再试" }, 429);
  }
  const code = normalizeRecoveryCode(body?.recovery_code);
  const newPassword = validatePassword(body?.new_password);
  if (!newPassword) return c.json({ error: "新密码需 8-128 个字符" }, 400);
  // uniform 401 for unknown name / no code set / wrong code: no account probing
  if (!name || !code) return c.json({ error: "用户名或恢复码错误" }, 401);
  const user = await c.env.DB.prepare("SELECT id, name, recovery_hash FROM users WHERE name = ?")
    .bind(name)
    .first<{ id: string; name: string; recovery_hash: string | null }>();
  if (!user?.recovery_hash || !(await verifyPassword(code, user.recovery_hash))) {
    return c.json({ error: "用户名或恢复码错误" }, 401);
  }
  const newToken = generateToken();
  const nextCode = generateRecoveryCode();
  const [passwordHash, nextHash] = await Promise.all([
    hashPassword(newPassword),
    hashPassword(normalizeRecoveryCode(nextCode)!),
  ]);
  // one-time consumption: the used code's hash is replaced atomically with the
  // new one, so a captured code can never be replayed
  await c.env.DB.prepare("UPDATE users SET password_hash = ?, api_token = ?, recovery_hash = ? WHERE id = ?")
    .bind(passwordHash, newToken, nextHash, user.id)
    .run();
  console.log(`recover: password reset for ${user.id}`);
  return c.json({ user: { id: user.id, name: user.name }, api_token: newToken, recovery_code: nextCode });
});

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ name?: unknown; password?: unknown }>().catch(() => null);
  const name = validateName(body?.name);
  if (!(await checkRateLimit(c.env.DB, "login", name ? [clientIp(c.req.raw), `acct:${name}`] : [clientIp(c.req.raw)]))) {
    return c.json({ error: "操作过于频繁，请一分钟后再试" }, 429);
  }
  const password = typeof body?.password === "string" ? body.password : "";
  if (!name || !password) return c.json({ error: "用户名或密码错误" }, 401);
  const user = await c.env.DB.prepare("SELECT id, name, api_token, password_hash FROM users WHERE name = ?")
    .bind(name)
    .first<{ id: string; name: string; api_token: string; password_hash: string | null }>();
  if (!user) return c.json({ error: "用户名或密码错误" }, 401);
  if (!user.password_hash) {
    return c.json({ error: "该账号未设置密码，请使用 API token 登录" }, 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: "用户名或密码错误" }, 401);
  }
  return c.json({ user: { id: user.id, name: user.name }, api_token: user.api_token });
});

// ---- admin maintenance (guarded by ADMIN_TOKEN worker secret, not user tokens) ----
// One-shot full reconcile across all users: drops 0-note orphan threads,
// dissolves 1-note leftovers, fixes stale note_count. Read-only for healthy data.
app.post("/api/admin/reconcile-threads", async (c) => {
  const adminToken = c.env.ADMIN_TOKEN;
  if (!adminToken) return c.json({ error: "not found" }, 404);
  const auth = c.req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== adminToken) return c.json({ error: "unauthorized" }, 401);
  const result = await reconcileThreads(c.env);
  return c.json({ ok: true, ...result });
});

// Manual trigger + self-check for the daily review sweep: returns per-user
// generation stats so "cron produced nothing" is diagnosable from outside.
app.post("/api/admin/run-daily-reviews", async (c) => {
  const adminToken = c.env.ADMIN_TOKEN;
  if (!adminToken) return c.json({ error: "not found" }, 404);
  const auth = c.req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== adminToken) return c.json({ error: "unauthorized" }, 401);
  // read the cron-side heartbeat BEFORE running, so the response can tell
  // "cron 没跑" (no/stale heartbeat) apart from "跑了但无素材" (fresh heartbeat, generated=0)
  const heartbeats = await readCronHeartbeats(c.env, ["daily_review:cron", "daily_review:admin"]);
  const stats = await generateAllDailyReviews(c.env, "admin");
  return c.json({
    ok: true,
    ...stats,
    heartbeats: heartbeats.map((h) => ({ ...h, stats: h.stats ? JSON.parse(h.stats) : null })),
  });
});

// ---- WeChat Official Account callback (公众号, public; guarded by WECHAT_MP_TOKEN) ----
// GET = URL 验证 (echostr); POST = 消息推送. Disabled (404) unless the token is set.

app.get("/wechat/mp", async (c) => {
  const token = c.env.WECHAT_MP_TOKEN;
  if (!token) return c.json({ error: "not found" }, 404);
  const q = c.req.query();
  if (!(await verifySignature(token, q.timestamp ?? "", q.nonce ?? "", q.signature ?? ""))) {
    return c.text("invalid signature", 403);
  }
  return c.text(q.echostr ?? "");
});

const WECHAT_BIND_HELP =
  "还未绑定碎念账号。请打开碎念 Web 端「设置 → 微信绑定」生成 6 位绑定码，然后把绑定码发给我（10 分钟内有效）。";

app.post("/wechat/mp", async (c) => {
  const token = c.env.WECHAT_MP_TOKEN;
  if (!token) return c.json({ error: "not found" }, 404);
  const q = c.req.query();
  const rawBody = await c.req.text();
  const aesMode = q.encrypt_type === "aes";

  let xml = rawBody;
  if (aesMode) {
    const aesKey = c.env.WECHAT_MP_AES_KEY;
    if (!aesKey) return c.text("aes mode not configured", 403);
    const outer = parseWechatXmlEncrypt(rawBody);
    if (!outer) return c.text("bad request", 400);
    if (!(await verifyMsgSignature(token, q.timestamp ?? "", q.nonce ?? "", outer, q.msg_signature ?? ""))) {
      return c.text("invalid signature", 403);
    }
    const decrypted = await decryptWechatMessage(aesKey, outer, c.env.WECHAT_MP_APPID);
    if (!decrypted) return c.text("decrypt failed", 400);
    xml = decrypted;
  } else if (!(await verifySignature(token, q.timestamp ?? "", q.nonce ?? "", q.signature ?? ""))) {
    return c.text("invalid signature", 403);
  }

  const msg = parseWechatXml(xml);
  if (!msg) return c.text("success");

  const reply = async (content: string): Promise<Response> => {
    const plain = buildTextReply(msg.fromUserName, msg.toUserName, content);
    if (aesMode && c.env.WECHAT_MP_AES_KEY && c.env.WECHAT_MP_APPID) {
      const enc = await encryptWechatMessage(c.env.WECHAT_MP_AES_KEY, plain, c.env.WECHAT_MP_APPID);
      if (enc) return c.text(await buildEncryptedReply(token, enc), 200, { "Content-Type": "application/xml" });
    }
    return c.text(plain, 200, { "Content-Type": "application/xml" });
  };

  // events: welcome on subscribe (with binding instructions), ack the rest
  if (msg.msgType === "event") {
    if ((msg.event ?? "").toLowerCase() === "subscribe") {
      return reply(`欢迎使用碎念！给我发消息就能记录一切。\n\n${WECHAT_BIND_HELP}`);
    }
    return c.text("success");
  }

  const openid = msg.fromUserName;
  const boundUserId = await lookupBinding(c.env.DB, openid);

  // unbound: only accept a bind code
  if (!boundUserId) {
    const code = msg.msgType === "text" && msg.content ? extractBindCode(msg.content) : null;
    if (code) {
      const userId = await consumeBindCode(c.env.DB, code, openid);
      if (userId) return reply("绑定成功 ✓ 现在直接发消息即可记录（文字/链接/图片/语音）。发送「解绑」可解除绑定。");
      return reply("绑定码无效或已过期，请回到碎念 Web 端「设置 → 微信绑定」重新生成。");
    }
    return reply(WECHAT_BIND_HELP);
  }

  // bound: route by message type
  if (msg.msgType === "text" && msg.content) {
    const text = msg.content.trim();
    if (text === "解绑" || text.toLowerCase() === "unbind") {
      await c.env.DB.prepare("DELETE FROM wechat_mp_bindings WHERE openid = ?").bind(openid).run();
      return reply("已解绑。需要时可在 Web 端设置页重新生成绑定码。");
    }
    if (/^[?？]/.test(text)) {
      return reply("公众号被动回复限时 5 秒，暂不支持问答检索；请到 Web 端「问一问」提问。消息不以 ? 开头即为正常记录。");
    }
    const tooLong = contentTooLong(c, text);
    if (tooLong) return reply(`内容过长：最多 ${MAX_CONTENT_CHARS} 字符，请拆成多条再发。`);
    await createNote(c, boundUserId, { content: text, source: "wechat" }, (p) => c.executionCtx.waitUntil(p), {
      syncTriage: false,
    });
    return reply("已存 ✓ AI 分拣中，稍后可在时间流查看。");
  }

  if (msg.msgType === "link" && msg.url) {
    const content = [msg.title, msg.description, msg.url].filter(Boolean).join("\n");
    await createNote(
      c,
      boundUserId,
      { content, url: msg.url, source: "wechat", raw_type: "link" },
      (p) => c.executionCtx.waitUntil(p),
      { syncTriage: false }
    );
    return reply("链接已存 ✓ 正在抓取摘要与分拣。");
  }

  if (msg.msgType === "image" && msg.picUrl) {
    const picUrl = msg.picUrl;
    c.executionCtx.waitUntil(
      capped(ingestWechatImage(c.env, boundUserId, picUrl, (p) => c.executionCtx.waitUntil(p)), PIPELINE_TIMEOUT_MS, `wechat image ${openid}`)
    );
    return reply("图片已收到 ✓ 正在提取文字并入库。");
  }

  if (msg.msgType === "voice") {
    // 开通了语音识别的公众号直接推 Recognition 文本；否则下载原始语音转写
    if (msg.recognition) {
      await createNote(
        c,
        boundUserId,
        { content: msg.recognition, source: "wechat", raw_type: "voice" },
        (p) => c.executionCtx.waitUntil(p),
        { syncTriage: false }
      );
      return reply("语音已存 ✓（微信识别文本）AI 分拣中。");
    }
    if (msg.mediaId && c.env.WECHAT_MP_APPID && c.env.WECHAT_MP_APPSECRET) {
      const mediaId = msg.mediaId;
      c.executionCtx.waitUntil(
        capped(ingestWechatVoice(c.env, boundUserId, mediaId, (p) => c.executionCtx.waitUntil(p)), PIPELINE_TIMEOUT_MS, `wechat voice ${openid}`)
      );
      return reply("语音已收到 ✓ 正在转写并入库。");
    }
    return reply("语音已收到，但当前公众号未开通语音识别、也未配置 AppSecret，暂无法转写。可发文字或图片。");
  }

  return reply("暂不支持该消息类型，目前支持：文字 / 链接 / 图片 / 语音。");
});

/** Background: download a WeChat image by PicUrl, run vision extraction, save as a note. */
async function ingestWechatImage(env: Env, userId: string, picUrl: string, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  let content: string | null = null;
  let meta: NoteMeta | null = null;
  try {
    const res = await fetch(picUrl);
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      const extraction = await describeImage(env, bytes);
      if (extraction) {
        content = extraction.content;
        if (extraction.description && extraction.description !== extraction.content) {
          meta = { image_description: extraction.description };
        }
      }
      const { note } = await createNote(
        { env },
        userId,
        { content: content ?? IMAGE_FAILED_PLACEHOLDER, source: "wechat", raw_type: "image", meta },
        waitUntil,
        { syncTriage: false }
      );
      await storeOriginal(env, userId, note.id, { type: "image", bytes, mime: res.headers.get("content-type") || "image/jpeg" });
      return;
    }
  } catch (e) {
    console.error("wechat image ingest failed", e);
  }
  await createNote({ env }, userId, { content: IMAGE_FAILED_PLACEHOLDER, source: "wechat", raw_type: "image" }, waitUntil, {
    syncTriage: false,
  });
}

/** Background: download a WeChat voice media, transcribe, save as a note. */
async function ingestWechatVoice(env: Env, userId: string, mediaId: string, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  let content: string | null = null;
  let meta: NoteMeta | null = null;
  let bytes: Uint8Array | null = null;
  let mime = "audio/amr";
  try {
    const media = await downloadMpMedia(env, mediaId);
    if (media) {
      bytes = media.bytes;
      mime = media.mime;
      const raw = await transcribeAudio(env, media.bytes);
      if (raw !== null) {
        const corrected = await correctTranscript(env, raw);
        content = corrected;
        if (corrected !== raw) meta = { raw_transcript: raw };
      }
    }
  } catch (e) {
    console.error("wechat voice ingest failed", e);
  }
  const { note } = await createNote(
    { env },
    userId,
    { content: content ?? AUDIO_FAILED_PLACEHOLDER, source: "wechat", raw_type: "voice", meta },
    waitUntil,
    { syncTriage: false }
  );
  if (bytes) await storeOriginal(env, userId, note.id, { type: "audio", bytes, mime });
}

/** Extract the <Encrypt> field from a safe-mode envelope. */
function parseWechatXmlEncrypt(xml: string): string | null {
  const m = xml.match(/<Encrypt>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/Encrypt>/);
  return m ? (m[1] ?? m[2] ?? "").trim() || null : null;
}

// ---- WeCom 微信客服 callback (public; guarded by WECOM_KF_* secrets) ----
// GET = URL 验证 (解密 echostr); POST = 事件回调 → sync_msg 拉取消息.
// Disabled (404) unless WECOM_KF_TOKEN + WECOM_KF_AES_KEY + WECOM_CORP_ID are set.

app.get("/wechat/kf", async (c) => {
  if (!wecomKfConfigured(c.env)) return c.json({ error: "not found" }, 404);
  const q = c.req.query();
  const echostr = q.echostr ?? "";
  if (!(await verifyMsgSignature(c.env.WECOM_KF_TOKEN!, q.timestamp ?? "", q.nonce ?? "", echostr, q.msg_signature ?? ""))) {
    return c.text("invalid signature", 403);
  }
  const plain = await decryptWechatMessage(c.env.WECOM_KF_AES_KEY!, echostr, c.env.WECOM_CORP_ID);
  if (plain === null) return c.text("decrypt failed", 400);
  return c.text(plain);
});

app.post("/wechat/kf", async (c) => {
  if (!wecomKfConfigured(c.env)) return c.json({ error: "not found" }, 404);
  const q = c.req.query();
  const rawBody = await c.req.text();
  const outer = parseWechatXmlEncrypt(rawBody);
  if (!outer) return c.text("bad request", 400);
  if (!(await verifyMsgSignature(c.env.WECOM_KF_TOKEN!, q.timestamp ?? "", q.nonce ?? "", outer, q.msg_signature ?? ""))) {
    return c.text("invalid signature", 403);
  }
  const xml = await decryptWechatMessage(c.env.WECOM_KF_AES_KEY!, outer, c.env.WECOM_CORP_ID);
  if (xml === null) return c.text("decrypt failed", 400);
  const cb = parseWecomKfCallback(xml);
  // ack fast; the actual message pull + ingest runs in the background
  if (cb && (cb.event ?? "") === "kf_msg_or_event") {
    const env = c.env;
    const waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);
    c.executionCtx.waitUntil(
      capped(processKfSync(env, cb.token, cb.openKfId, waitUntil), PIPELINE_TIMEOUT_MS, "wecom kf sync")
    );
  }
  return c.text("success");
});

const WECOM_KF_BIND_HELP =
  "还未绑定碎念账号。请打开碎念 Web 端「设置 → 微信绑定」生成 6 位绑定码，然后把绑定码发给我（10 分钟内有效）。";

/** Pull new kf messages and ingest each customer message. */
async function processKfSync(
  env: Env,
  syncToken: string | undefined,
  openKfId: string | undefined,
  waitUntil: (p: Promise<unknown>) => void
): Promise<void> {
  const messages = await syncKfMessages(env, syncToken, openKfId);
  for (const msg of messages) {
    try {
      await handleKfMessage(env, msg, waitUntil);
    } catch (e) {
      console.error("wecom kf: message handling failed", msg.msgid, e);
    }
  }
}

/** Route a single 微信客服 message through binding / ingest, replying via send_msg. */
async function handleKfMessage(env: Env, msg: KfMessage, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  const externalUserid = msg.external_userid || msg.event?.external_userid || "";
  const openKfId = msg.open_kfid || msg.event?.open_kfid || "";
  if (!externalUserid || !openKfId) return;
  const reply = (content: string) => sendKfText(env, openKfId, externalUserid, content);

  if (msg.msgtype === "event") {
    if ((msg.event?.event_type ?? "") === "enter_session") {
      const bound = await lookupKfBinding(env.DB, externalUserid);
      if (!bound) await reply(`欢迎使用碎念！发消息、转发文章/文件给我就能记录。\n\n${WECOM_KF_BIND_HELP}`);
    }
    return;
  }

  // only ingest messages sent by the WeChat customer (origin 3)
  if (msg.origin !== 3) return;

  const boundUserId = await lookupKfBinding(env.DB, externalUserid);

  if (!boundUserId) {
    const code = msg.msgtype === "text" && msg.text?.content ? extractBindCode(msg.text.content) : null;
    if (code) {
      const userId = await consumeBindCodeKf(env.DB, code, externalUserid);
      if (userId) {
        await reply("绑定成功 ✓ 现在直接发消息即可记录（文字/链接/图片/语音/文件/小程序）。发送「解绑」可解除绑定。");
        return;
      }
      await reply("绑定码无效或已过期，请回到碎念 Web 端「设置 → 微信绑定」重新生成。");
      return;
    }
    await reply(WECOM_KF_BIND_HELP);
    return;
  }

  if (msg.msgtype === "text" && msg.text?.content) {
    const text = msg.text.content.trim();
    if (text === "解绑" || text.toLowerCase() === "unbind") {
      await env.DB.prepare("DELETE FROM wecom_kf_bindings WHERE external_userid = ?").bind(externalUserid).run();
      await reply("已解绑。需要时可在 Web 端设置页重新生成绑定码。");
      return;
    }
    if (/^[?？]/.test(text)) {
      await reply("客服通道暂不支持问答检索，请到 Web 端「问一问」提问。消息不以 ? 开头即为正常记录。");
      return;
    }
    if (text.length > MAX_CONTENT_CHARS) {
      await reply(`内容过长：最多 ${MAX_CONTENT_CHARS} 字符，请拆成多条再发。`);
      return;
    }
    await createNote({ env }, boundUserId, { content: text, source: "wechat" }, waitUntil, { syncTriage: false });
    await reply("已存 ✓ AI 分拣中，稍后可在时间流查看。");
    return;
  }

  if (msg.msgtype === "link" && msg.link?.url) {
    const content = [msg.link.title, msg.link.desc, msg.link.url].filter(Boolean).join("\n");
    await createNote(
      { env },
      boundUserId,
      { content, url: msg.link.url, source: "wechat", raw_type: "link" },
      waitUntil,
      { syncTriage: false }
    );
    await reply("链接已存 ✓ 正在抓取摘要与分拣。");
    return;
  }

  if (msg.msgtype === "image" && msg.image?.media_id) {
    const mediaId = msg.image.media_id;
    waitUntil(capped(ingestKfImage(env, boundUserId, mediaId, waitUntil), PIPELINE_TIMEOUT_MS, `wecom image ${externalUserid}`));
    await reply("图片已收到 ✓ 正在提取文字并入库。");
    return;
  }

  if (msg.msgtype === "voice" && msg.voice?.media_id) {
    const mediaId = msg.voice.media_id;
    waitUntil(capped(ingestKfVoice(env, boundUserId, mediaId, waitUntil), PIPELINE_TIMEOUT_MS, `wecom voice ${externalUserid}`));
    await reply("语音已收到 ✓ 正在转写并入库。");
    return;
  }

  if (msg.msgtype === "file" && msg.file?.media_id) {
    const mediaId = msg.file.media_id;
    const filename = msg.file.filename;
    waitUntil(
      capped(
        ingestKfFile(env, boundUserId, mediaId, filename, openKfId, externalUserid),
        PIPELINE_TIMEOUT_MS,
        `wecom file ${externalUserid}`
      )
    );
    await reply("文件已收到 ✓ 正在提取文本并入库。");
    return;
  }

  if (msg.msgtype === "miniprogram" && (msg.miniprogram?.title || msg.miniprogram?.appid)) {
    const mp = msg.miniprogram!;
    const content = [`【小程序】${mp.title ?? ""}`.trim(), mp.appid ? `appid: ${mp.appid}` : null, mp.pagepath ? `页面: ${mp.pagepath}` : null]
      .filter(Boolean)
      .join("\n");
    await createNote({ env }, boundUserId, { content, source: "wechat", raw_type: "text" }, waitUntil, { syncTriage: false });
    await reply("小程序卡片已存 ✓（标题与页面路径）。");
    return;
  }

  await reply("暂不支持该消息类型，目前支持：文字 / 链接 / 图片 / 语音 / 文件 / 小程序卡片。（合并转发的聊天记录官方接口暂不支持）");
}

/** Background: download a kf image, run vision extraction, save as a note. */
async function ingestKfImage(env: Env, userId: string, mediaId: string, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  let content: string | null = null;
  let meta: NoteMeta | null = null;
  let bytes: Uint8Array | null = null;
  let mime = "image/jpeg";
  try {
    const media = await downloadWecomMedia(env, mediaId);
    if (media) {
      bytes = media.bytes;
      mime = media.mime;
      const extraction = await describeImage(env, media.bytes);
      if (extraction) {
        content = extraction.content;
        if (extraction.description && extraction.description !== extraction.content) {
          meta = { image_description: extraction.description };
        }
      }
    }
  } catch (e) {
    console.error("wecom kf image ingest failed", e);
  }
  const { note } = await createNote(
    { env },
    userId,
    { content: content ?? IMAGE_FAILED_PLACEHOLDER, source: "wechat", raw_type: "image", meta },
    waitUntil,
    { syncTriage: false }
  );
  if (bytes) await storeOriginal(env, userId, note.id, { type: "image", bytes, mime });
}

/** Background: download a kf voice media, transcribe, save as a note. */
async function ingestKfVoice(env: Env, userId: string, mediaId: string, waitUntil: (p: Promise<unknown>) => void): Promise<void> {
  let content: string | null = null;
  let meta: NoteMeta | null = null;
  let bytes: Uint8Array | null = null;
  let mime = "audio/amr";
  try {
    const media = await downloadWecomMedia(env, mediaId);
    if (media) {
      bytes = media.bytes;
      mime = media.mime;
      const raw = await transcribeAudio(env, media.bytes);
      if (raw !== null) {
        const corrected = await correctTranscript(env, raw);
        content = corrected;
        if (corrected !== raw) meta = { raw_transcript: raw };
      }
    }
  } catch (e) {
    console.error("wecom kf voice ingest failed", e);
  }
  const { note } = await createNote(
    { env },
    userId,
    { content: content ?? AUDIO_FAILED_PLACEHOLDER, source: "wechat", raw_type: "voice", meta },
    waitUntil,
    { syncTriage: false }
  );
  if (bytes) await storeOriginal(env, userId, note.id, { type: "audio", bytes, mime });
}

/** Background: download a kf file, extract text (PDF/txt/md/docx), save as a note + archive the original. */
async function ingestKfFile(
  env: Env,
  userId: string,
  mediaId: string,
  filenameHint: string | undefined,
  openKfId: string,
  externalUserid: string
): Promise<void> {
  const waitUntil = (p: Promise<unknown>) => void p.catch((e) => console.error("wecom kf file bg", e));
  try {
    const media = await downloadWecomMedia(env, mediaId);
    if (!media) {
      await sendKfText(env, openKfId, externalUserid, "文件下载失败，请稍后重发。");
      return;
    }
    const fileName = filenameHint || media.filename || "file";
    const kind = detectFileKind(fileName, media.mime);
    const meta: NoteMeta = {
      file_name: fileName,
      file_mime: media.mime,
      file_size: media.bytes.length,
    };
    let content: string;
    let extracted = false;
    if (kind) {
      const result = await buildFileNote(env, kind, fileName, media.bytes);
      content = result.content.length > MAX_CONTENT_CHARS ? result.content.slice(0, MAX_CONTENT_CHARS) : result.content;
      extracted = result.extracted;
      meta.file_kind = kind;
      if (result.excerpt) meta.file_excerpt = result.excerpt;
      meta.file_status = result.extracted ? "ok" : "extract_failed";
    } else {
      content = `${FILE_FAILED_PLACEHOLDER}：${fileName}`;
      meta.file_status = "extract_failed";
    }
    const { note } = await createNote({ env }, userId, { content, source: "wechat", raw_type: "file", meta }, waitUntil, {
      syncTriage: false,
    });
    await storeOriginal(env, userId, note.id, { type: "file", bytes: media.bytes, mime: media.mime, fileName });
    await sendKfText(env, openKfId, externalUserid, buildFileReply(fileName, content, extracted));
  } catch (e) {
    console.error("wecom kf file ingest failed", e);
  }
}

// ---- auth ----
app.use("/api/*", async (c, next) => {
  const auth = c.req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return c.json({ error: "unauthorized" }, 401);
  const row = await c.env.DB.prepare("SELECT id FROM users WHERE api_token = ?")
    .bind(m[1])
    .first<{ id: string }>();
  if (!row) return c.json({ error: "unauthorized" }, 401);
  c.set("userId", row.id);
  const touch = c.env.DB.prepare("UPDATE users SET last_used_at = datetime('now') WHERE id = ?")
    .bind(row.id)
    .run()
    .then(() => undefined)
    .catch(() => undefined);
  try {
    c.executionCtx.waitUntil(touch);
  } catch {
    // no ExecutionContext (unit tests): the update still runs in the background
  }
  await next();
});

// ---- authenticated auth endpoints ----
app.get("/api/auth/me", async (c) => {
  const user = await c.env.DB.prepare("SELECT id, name, created_at, password_hash, last_used_at FROM users WHERE id = ?")
    .bind(c.get("userId"))
    .first<{ id: string; name: string; created_at: string; password_hash: string | null; last_used_at: string | null }>();
  if (!user) return c.json({ error: "not found" }, 404);
  return c.json({
    user: {
      id: user.id,
      name: user.name,
      created_at: user.created_at,
      has_password: !!user.password_hash,
      last_used_at: user.last_used_at,
    },
  });
});

app.post("/api/auth/rotate-token", async (c) => {
  const token = generateToken();
  await c.env.DB.prepare("UPDATE users SET api_token = ? WHERE id = ?").bind(token, c.get("userId")).run();
  return c.json({ api_token: token });
});

// ---- POST /api/auth/recovery-code ----
// (Re)generate the account's recovery code; invalidates any previous code.
// Rate-limited so a hijacked session can't grind PBKDF2 hashing for free.
app.post("/api/auth/recovery-code", async (c) => {
  const userId = c.get("userId");
  if (!(await checkRateLimit(c.env.DB, "recovery_code", [userId]))) {
    return c.json({ error: "操作过于频繁，请一分钟后再试" }, 429);
  }
  const code = generateRecoveryCode();
  const hash = await hashPassword(normalizeRecoveryCode(code)!);
  await c.env.DB.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?").bind(hash, userId).run();
  return c.json({ recovery_code: code });
});

// self-serve account deletion: cascades all user data (notes/threads/reports/media)
app.delete("/api/auth/me", async (c) => {
  const userId = c.get("userId");
  const atts = await c.env.DB.prepare(
    "SELECT a.r2_key FROM attachments a JOIN notes n ON a.note_id = n.id WHERE n.user_id = ?"
  )
    .bind(userId)
    .all<{ r2_key: string }>();
  if (c.env.MEDIA && (atts.results ?? []).length > 0) {
    c.executionCtx.waitUntil(
      c.env.MEDIA.delete((atts.results ?? []).map((a) => a.r2_key)).catch((e) => console.error("r2 delete failed", e))
    );
  }
  if (c.env.VECTORIZE) {
    const ids = await c.env.DB.prepare("SELECT id FROM notes WHERE user_id = ?").bind(userId).all<{ id: string }>();
    const vec = c.env.VECTORIZE;
    c.executionCtx.waitUntil(
      vec.deleteByIds((ids.results ?? []).map((r) => r.id)).catch((e) => console.error("vectorize delete failed", e))
    );
  }
  await deleteUserData(c.env, userId);
  return c.json({ ok: true });
});

// Legacy rows stored todo_due without a UTC offset; those values are Asia/Shanghai local times.
export function normalizeStoredTodoDue(v: string | null): string | null {
  if (!v) return v;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/);
  return m ? `${m[1]}T${m[2]}:00+08:00` : v;
}

function noteToJson(n: NoteRow) {
  return {
    ...n,
    todo_due: normalizeStoredTodoDue(n.todo_due),
    tags: JSON.parse(n.tags || "[]") as string[],
    meta: parseNoteMeta(n.meta),
    url_titles: n.url_titles ? (JSON.parse(n.url_titles) as { url: string; title: string | null }[]) : null,
    is_sensitive: !!n.is_sensitive,
    todo_done: !!n.todo_done,
    content_enc: undefined,
  };
}

/** Decrypt an encrypted sensitive note's content for an authorized response; never throws. */
async function decryptNoteRow(env: Env, n: NoteRow): Promise<NoteRow> {
  if (n.is_sensitive && n.content_enc && env.SUINIAN_ENC_KEY) {
    const plain = await decryptContent(env.SUINIAN_ENC_KEY, n.content_enc);
    if (plain !== null) return { ...n, content: plain };
  }
  return n;
}

async function noteToJsonDecrypted(env: Env, n: NoteRow) {
  return noteToJson(await decryptNoteRow(env, n));
}

/**
 * Batch-load attachment metadata for a page of note JSONs and merge it in as
 * `attachments` (R144 P1-1), so clients can render originals (image/audio/file)
 * through the authenticated /api/notes/:id/file proxy — no public R2 URLs.
 */
async function withAttachments<T extends { id: string }>(env: Env, notes: T[]): Promise<(T & { attachments?: { id: string; name: string; mime: string | null; size: number | null }[] })[]> {
  if (notes.length === 0) return notes;
  try {
    const ph = notes.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT id, note_id, r2_key, mime, size FROM attachments WHERE note_id IN (${ph}) ORDER BY rowid ASC`
    )
      .bind(...notes.map((n) => n.id))
      .all<{ id: string; note_id: string; r2_key: string; mime: string | null; size: number | null }>();
    if (!results || results.length === 0) return notes;
    const byNote = new Map<string, { id: string; name: string; mime: string | null; size: number | null }[]>();
    for (const a of results) {
      const base = a.r2_key.split("/").pop() || "file";
      const name = base.replace(/^\d{10,}-/, "");
      const list = byNote.get(a.note_id) ?? [];
      list.push({ id: a.id, name, mime: a.mime, size: a.size });
      byNote.set(a.note_id, list);
    }
    return notes.map((n) => (byNote.has(n.id) ? { ...n, attachments: byNote.get(n.id) } : n));
  } catch (e) {
    console.error("withAttachments: failed", e);
    return notes;
  }
}

const CATEGORY_LABEL: Record<string, string> = {
  idea: "想法",
  todo: "待办",
  collect: "收藏",
  data: "资料",
  expense: "支出",
  income: "收入",
  transfer: "资金往来",
};

/**
 * Render enumeration answer lines, folding notes that display identically
 * (same category + same first line, e.g. re-saved duplicates or several
 * encrypted rows) into one line with a ×N count.
 */
function enumNoteLines(rows: NoteRow[]): string[] {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const n of rows) {
    const label = n.category ? (CATEGORY_LABEL[n.category] ?? n.category) : "待分类";
    const text = n.is_sensitive ? "（加密的敏感笔记）" : (n.title || n.content.split("\n")[0] || "").slice(0, 40);
    const line = "- ［" + label + "］" + text;
    if (!counts.has(line)) order.push(line);
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return order.map((line) => (counts.get(line)! > 1 ? line + " ×" + counts.get(line) : line));
}

async function fetchLinkMetaInto(env: Env, noteId: string, urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const metas = await Promise.all(urls.map((u) => fetchLinkMeta(u)));
  const first = metas[0];
  const urlTitles = urls.map((u, i) => ({ url: u, title: metas[i].title }));
  if (first.title || first.description || urlTitles.some((t) => t.title)) {
    // 敏感行不落链接派生明文（与 note-store 同口径）
    await env.DB.prepare(
      "UPDATE notes SET url_title = ?, url_summary = ?, url_titles = ?, updated_at = datetime('now') WHERE id = ? AND is_sensitive = 0"
    )
      .bind(first.title, first.description, JSON.stringify(urlTitles), noteId)
      .run();
  }
}


/** Resolve when `p` settles or after `ms`, whichever comes first; never rejects. */
export function capped(p: Promise<unknown>, ms: number, label: string): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`background task timed out after ${ms}ms: ${label}`);
      resolve();
    }, ms);
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err) => {
        clearTimeout(timer);
        console.error(`background task failed: ${label}`, err);
        resolve();
      }
    );
  });
}

async function createNote(
  c: { env: Env },
  userId: string,
  body: { source?: string; raw_type?: string; content?: string; url?: string; meta?: NoteMeta | null; tags?: string[] },
  waitUntil: (p: Promise<unknown>) => void,
  opts: { syncTriage: boolean; skipTriage?: boolean }
): Promise<{ note: NoteRow; triage: TriageResult | null }> {
  const id = crypto.randomUUID();
  const content = (body.content ?? "").trim();
  const url = body.url || extractUrl(content);
  const urls = body.url && !content.includes(body.url) ? [body.url, ...extractUrls(content, 2)] : extractUrls(content, 3);
  const source = body.source || "api";
  const rawType = body.raw_type || (url && content === url ? "link" : "text");
  const manualTags = (body.tags ?? []).filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim().replace(/^#/, "")).slice(0, 6);
  // skipTriage (`!` inline command): store as-is under 想法 and mark the fields
  // manual so neither the sync triage nor the cron sweep re-sorts it. 敏感复判
  // 不在豁免之列（R126 P1-2）：skip 只跳过分类/打标，全部字段标 manual 后，
  // 疑似含密的内容仍走 fail-closed 预检 + 模型复判，只裁决敏感与否。
  const meta: NoteMeta | null =
    opts.skipTriage || manualTags.length > 0
      ? {
          ...(body.meta ?? {}),
          manual_override: {
            ...(opts.skipTriage ? { category: true, tags: true, title: true, todo_due: true } : {}),
            ...(manualTags.length > 0 ? { tags: true } : {}),
          },
        }
      : (body.meta ?? null);

  // sync sensitive pre-check (no AI call), fail-closed: while the note waits
  // for AI triage, anything that certainly OR possibly contains a secret is
  // encrypted from the very first write, so the pending window never serves
  // plaintext through backup/export/MCP/list paths. The model stays the
  // primary judge — applyTriage restores plaintext when it says non-sensitive.
  // insert immediately (category resolved by triage, sync or async)
  const { stmt } = await prepareNoteInsert(
    c.env,
    c.env.DB,
    {
      id,
      user_id: userId,
      source,
      raw_type: rawType,
      content,
      url: url ?? null,
      category: opts.skipTriage ? "idea" : null,
      tags: manualTags,
      meta,
    },
    // 敏感闸门对 skipTriage 同口径（R126 P1-2）：宽口径疑似命中也 fail-closed
    // 加密并标 needs_retriage，cron 只复判敏感与否（分类/标签已标 manual）
    { rejudge: true, markSensitive: "onlyEncrypted" }
  );
  await stmt.run();

  const runTriage = async (retry: boolean): Promise<TriageResult | null> => {
    const topTags = await loadTopTags(c.env.DB, userId).catch(() => [] as string[]);
    const corrections = await loadCategoryCorrections(c.env.DB, userId).catch(() => []);
    const tz = await loadUserTz(c.env, userId);
    let triage = await triageNote(content, c.env, topTags, tz, corrections);
    // a concurrent burst of quick notes can trip provider rate limits and fail
    // most of the batch at once; the async path retries inside the same
    // waitUntil with jittered backoff (the jitter de-synchronizes the burst)
    // so those notes sort within seconds instead of waiting for the cron sweep
    if (retry) {
      for (const base of TRIAGE_RETRY_DELAYS_MS) {
        if (triage) break;
        await sleep(base + Math.random() * base);
        triage = await triageNote(content, c.env, topTags, tz, corrections);
      }
    }
    // still null = AI unavailable: keep category NULL so the sweeps retry later
    if (triage) await applyTriage(c.env, id, triage, content);
    return triage;
  };

  // link metadata always in background; full article extraction + AI summary
  // runs after triage so the tag merge never races with applyTriage
  if (urls.length > 0) waitUntil(capped(fetchLinkMetaInto(c.env, id, urls), PIPELINE_TIMEOUT_MS, `linkmeta note=${id}`));

  const runPipeline = async (withTriage: boolean) => {
    if (withTriage) await runTriage(true);
    const n = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
    if (n) {
      await extractGraph(c.env, n);
      const tid = await clusterNote(c.env, n);
      await upsertNoteEmbedding(c.env, n);
      // concurrent same-topic saves can each create a thread (the cluster
      // reads race); a scoped merge after the embedding is stored heals the
      // split — running it post-embed means the last note to finish sees every
      // racing thread with a fresh representative vector
      if (tid) await mergeDuplicateThreads(c.env, userId, tid);
    }
    if (url) {
      await enrichLinkInto(c.env, id);
      // link summary landed after the first embed/cluster pass: refresh the
      // vector and give unthreaded collects a retry with the richer text
      const enriched = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
      if (enriched?.url_summary) {
        await upsertNoteEmbedding(c.env, enriched);
        if (enriched.category === "collect" && !enriched.thread_id) await clusterNote(c.env, enriched);
      }
    }
  };

  let triage: TriageResult | null = null;
  if (opts.skipTriage) {
    waitUntil(capped(runPipeline(false), PIPELINE_TIMEOUT_MS, `pipeline note=${id}`));
  } else if (opts.syncTriage) {
    // sync path (wechat reply) stays single-attempt: the reply must be fast
    triage = await runTriage(false);
    waitUntil(capped(runPipeline(false), PIPELINE_TIMEOUT_MS, `pipeline note=${id}`));
  } else {
    waitUntil(capped(runPipeline(true), PIPELINE_TIMEOUT_MS, `pipeline note=${id}`));
  }

  const note = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
  return { note: note!, triage };
}

// ---- POST /api/notes ----
app.post("/api/notes", async (c) => {
  const body = await c.req
    .json<{ source?: string; raw_type?: string; content?: string; url?: string; tags?: string[]; skip_triage?: boolean; meta?: NoteMeta | null }>()
    .catch(() => null);
  // 非字符串 content（数字/对象/数组）必须是 400 而不是下游 500（R120 P2）
  if (!body || typeof body.content !== "string" || !body.content.trim()) {
    return c.json({ error: "content 必须是非空字符串" }, 400);
  }
  const tooLong = contentTooLong(c, body.content);
  if (tooLong) return tooLong;
  const userId = c.get("userId");
  // 写入频率上限（R120 P2）：泄露的 token / 失控脚本不能无限刷 AI 配额
  if (!(await checkRateLimit(c.env.DB, "note_write", [userId], NOTE_WRITE_RATE_LIMIT_MAX))) {
    return c.json({ error: "写入太频繁了，请稍等一分钟再试", retryable: true }, 429);
  }
  // skip_triage (`!` inline command): store as-is, never re-sorted
  const skipTriage = body.skip_triage === true;
  // 客户端 meta 白名单（R126 P1-1）：只收标记位，不收任何可携带明文的
  // 自由文本字段（否则 meta.* 成为绕过敏感管道的明文旁路）
  const clientMeta: NoteMeta | null = body.meta?.from_ask === true ? { from_ask: true } : null;
  // returns immediately; triage + link fetch + clustering backfill asynchronously
  const { note } = await createNote(c, userId, { ...body, meta: clientMeta }, (p) => c.executionCtx.waitUntil(p), { syncTriage: false, skipTriage });
  return c.json({ note: await noteToJsonDecrypted(c.env, note) }, 201);
});

// Shared filter SQL for GET /api/notes and POST /api/notes/batch: category /
// tag / keyword / source / created_at range, all combinable.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

/** Split a keyword query into up to 5 whitespace-separated terms. */
export function searchTerms(q: string): string[] {
  return q.split(/\s+/).filter(Boolean).slice(0, 5);
}

// tags 参与关键词命中：ask 敏感提示推荐的搜索词可能只出现在标签里，
// 时间流搜索必须能搜到同一批笔记（与 ask 召回/敏感计数口径对齐）
const KEYWORD_FIELDS = ["content", "title", "url_title", "url_summary", "tags"] as const;

function termCond(): string {
  return `(${KEYWORD_FIELDS.map((f) => `${f} LIKE ?`).join(" OR ")})`;
}

/** How many of the query terms a note matches across the searchable fields. */
export function matchedTermCount(
  note: { content: string; title: string | null; url_title: string | null; url_summary: string | null; tags?: string | null },
  terms: string[]
): number {
  const hay = [note.content, note.title, note.url_title, note.url_summary, note.tags]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return terms.filter((t) => hay.includes(t.toLowerCase())).length;
}

function noteFilterConds(filter: {
  category?: unknown;
  tag?: unknown;
  q?: unknown;
  source?: unknown;
  from?: unknown;
  to?: unknown;
}): { conds: string[]; binds: unknown[] } {
  const conds: string[] = ["deleted_at IS NULL"];
  const binds: unknown[] = [];
  if (typeof filter.category === "string" && filter.category) {
    conds.push("category = ?");
    binds.push(filter.category);
  }
  if (typeof filter.tag === "string" && filter.tag) {
    conds.push("tags LIKE ?");
    binds.push(`%"${filter.tag}"%`);
  }
  if (typeof filter.q === "string" && filter.q.trim()) {
    // multi-word queries match notes containing every term (in any field, any
    // order) instead of requiring the words as one contiguous substring
    for (const term of searchTerms(filter.q)) {
      conds.push(termCond());
      const like = `%${term}%`;
      for (let i = 0; i < KEYWORD_FIELDS.length; i++) binds.push(like);
    }
  }
  if (typeof filter.source === "string" && filter.source) {
    conds.push("source = ?");
    binds.push(filter.source);
  }
  if (typeof filter.from === "string" && DATETIME_RE.test(filter.from)) {
    conds.push("created_at >= ?");
    binds.push(filter.from.length === 10 ? `${filter.from} 00:00:00` : filter.from);
  }
  if (typeof filter.to === "string" && DATETIME_RE.test(filter.to)) {
    conds.push("created_at <= ?");
    binds.push(filter.to.length === 10 ? `${filter.to} 23:59:59` : filter.to);
  }
  return { conds, binds };
}

// ---- GET /api/notes ----
app.get("/api/notes", async (c) => {
  const userId = c.get("userId");
  const { category, tag, q, cursor, source, from, to } = c.req.query();
  const rawLimit = parseInt(c.req.query("limit") ?? "", 10);
  const limit = Number.isNaN(rawLimit) ? 20 : Math.max(1, Math.min(100, rawLimit));

  const filter = noteFilterConds({ category, tag, q, source, from, to });
  const conds: string[] = ["user_id = ?", ...filter.conds];
  const binds: unknown[] = [userId, ...filter.binds];
  if (cursor) {
    const cur = decodeCursor(cursor);
    if (!cur) return c.json({ error: "invalid cursor" }, 400);
    conds.push("(created_at < ? OR (created_at = ? AND id < ?))");
    binds.push(cur.createdAt, cur.createdAt, cur.id);
  }

  const sql = `SELECT * FROM notes WHERE ${conds.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`;
  binds.push(limit + 1);
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<NoteRow>();
  const rows = results ?? [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const next = hasMore && page.length > 0 ? encodeCursor(page[page.length - 1].created_at, page[page.length - 1].id) : null;

  // hybrid recall on the first page of a text search: keyword hits + semantic
  // hits (Vectorize/D1 vectors), deduped and ranked by relevance; any semantic
  // failure leaves the pure keyword results untouched
  if (q && !cursor) {
    const terms = searchTerms(q);
    const hits = await semanticRecall(c.env, userId, q, 10);
    const kwIds = new Set(page.map((n) => n.id));
    const semScore = new Map(hits.map((h) => [h.note_id, h.score]));
    // multi-word relevance: notes hitting only SOME terms still surface,
    // ranked below full hits (all-term matches first, partial next)
    let partial: NoteRow[] = [];
    if (terms.length > 1) {
      const pf = noteFilterConds({ category, tag, source, from, to });
      const orTerms = terms.map(() => termCond()).join(" OR ");
      const termBinds = terms.flatMap((t) => Array(KEYWORD_FIELDS.length).fill(`%${t}%`) as string[]);
      const where = [`user_id = ?`, ...pf.conds, `(${orTerms})`].join(" AND ");
      const r = await c.env.DB.prepare(
        `SELECT * FROM notes WHERE ${where} ORDER BY created_at DESC LIMIT 30`
      )
        .bind(userId, ...pf.binds, ...termBinds)
        .all<NoteRow>();
      partial = (r.results ?? []).filter((n) => !kwIds.has(n.id));
    }
    const partialIds = new Set(partial.map((n) => n.id));
    const extraIds = hits.filter((h) => !kwIds.has(h.note_id) && !partialIds.has(h.note_id)).map((h) => h.note_id);
    let extra: NoteRow[] = [];
    if (extraIds.length > 0) {
      // semantic extras must satisfy the same structured filters (minus keyword)
      const ef = noteFilterConds({ category, tag, source, from, to });
      const ph = extraIds.map(() => "?").join(",");
      const where = [`user_id = ?`, `id IN (${ph})`, ...ef.conds].join(" AND ");
      const r = await c.env.DB.prepare(`SELECT * FROM notes WHERE ${where}`)
        .bind(userId, ...extraIds, ...ef.binds)
        .all<NoteRow>();
      extra = r.results ?? [];
    }
    const merged = [...page, ...partial, ...extra];
    const relevance = (n: NoteRow) =>
      (semScore.get(n.id) ?? 0) +
      (kwIds.has(n.id) ? 0.75 : partialIds.has(n.id) ? 0.75 * (matchedTermCount(n, terms) / terms.length) : 0);
    merged.sort((a, b) => relevance(b) - relevance(a));
    const notes = await withAttachments(
      c.env,
      await Promise.all(
        merged.map(async (n) => ({
          ...(await noteToJsonDecrypted(c.env, n)),
          match:
            kwIds.has(n.id) || partialIds.has(n.id) ? (semScore.has(n.id) ? "both" : "keyword") : "semantic",
        }))
      )
    );
    return c.json({ notes, next_cursor: next });
  }

  const notes = await withAttachments(c.env, await Promise.all(page.map((n) => noteToJsonDecrypted(c.env, n))));

  // opportunistic sweep: a visible pending note older than the in-request
  // retry window means its async triage died (isolate evicted / AI burst
  // failure) — re-triage this user's backlog now instead of waiting for the
  // 10-min cron; per-isolate throttle keeps polling clients from stampeding.
  // Kicked only AFTER the response body is fully built: the retriage's AI/D1
  // subrequests share this request's simultaneous-connection budget, and
  // launching them earlier can starve the response's own tail queries under a
  // slow AI provider (R147 P1-1: intermittent 60s timeline hangs during large
  // backlogs, while q= searches — which return before the kick — stayed fast).
  const stale = page.some(
    (n) => n.category === null && Date.now() - Date.parse(`${n.created_at.replace(" ", "T")}Z`) > 60_000
  );
  if (stale && shouldKickRetriage(userId)) {
    c.executionCtx.waitUntil(
      capped(retriageUnsorted(c.env, 15, 25_000, userId), 30_000, `retriage kick user=${userId}`)
    );
  }

  return c.json({ notes, next_cursor: next });
});

/** Per-isolate throttle for the GET /api/notes retriage kick (one per user per minute). */
const lastRetriageKick = new Map<string, number>();
function shouldKickRetriage(userId: string): boolean {
  const now = Date.now();
  const last = lastRetriageKick.get(userId) ?? 0;
  if (now - last < 60_000) return false;
  lastRetriageKick.set(userId, now);
  if (lastRetriageKick.size > 1000) lastRetriageKick.clear();
  return true;
}

/** 409 with the latest server copy so the client can refresh and re-apply the edit. */
async function conflictResponse(c: Context<{ Bindings: Env; Variables: Vars }>, id: string) {
  const note = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
  return c.json(
    { error: "该笔记刚被其他设备修改，已返回最新内容，请基于最新内容重试", note: note ? await noteToJsonDecrypted(c.env, note) : null },
    409
  );
}

// ---- PATCH /api/notes/:id ----
app.patch("/api/notes/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid body" }, 400);

  // 编辑触发 AI 重算标题/复判，与新建同费：共用 note_write 限流桶
  if (typeof body.content === "string" && !(await checkRateLimit(c.env.DB, "note_write", [userId], NOTE_WRITE_RATE_LIMIT_MAX))) {
    return c.json({ error: "操作太频繁了，请稍等一分钟再试", retryable: true }, 429);
  }

  const existing = await c.env.DB.prepare(
    "SELECT is_sensitive, id, user_id, content, content_enc, meta, tags, updated_at FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  )
    .bind(id, userId)
    .first<{ is_sensitive: number; id: string; user_id: string; content: string; content_enc: string | null; meta: string | null; tags: string; updated_at: string }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  // optimistic lock: clients editing a loaded note send its updated_at back so
  // a concurrent edit from another device surfaces as 409 instead of a silent
  // last-write-wins overwrite
  if (typeof body.base_updated_at === "string" && body.base_updated_at !== existing.updated_at) {
    return conflictResponse(c, id);
  }

  if (typeof body.content === "string") {
    if (!body.content.trim()) return c.json({ error: "内容不能为空，如需删除请用删除操作" }, 400);
    const tooLong = contentTooLong(c, body.content);
    if (tooLong) return tooLong;
  }

  // 内容/标题/标签/敏感位的修改统一交给持久层 applyNotePatch 过敏感管道
  //（R123 P1 结构性收口）；这里只组装非守护字段与 manual_override
  const patch: {
    content?: string;
    title?: string;
    tags?: string[];
    is_sensitive?: boolean;
    meta?: NoteMeta;
  } = {};
  if (typeof body.content === "string") patch.content = body.content;
  if (typeof body.is_sensitive === "boolean") patch.is_sensitive = body.is_sensitive;
  if (typeof body.title === "string") patch.title = body.title;
  if (Array.isArray(body.tags)) patch.tags = body.tags.filter((t): t is string => typeof t === "string");

  const extraSets: string[] = [];
  const extraBinds: unknown[] = [];
  if (typeof body.todo_done === "boolean") {
    extraSets.push("todo_done = ?", "done_at = ?");
    extraBinds.push(body.todo_done ? 1 : 0, body.todo_done ? new Date().toISOString() : null);
  }
  const override: { category?: boolean; tags?: boolean; todo_due?: boolean; title?: boolean } = {};
  if (typeof body.category === "string" && ["idea", "todo", "collect", "data", "expense", "income", "transfer"].includes(body.category)) {
    extraSets.push("category = ?");
    extraBinds.push(body.category);
    override.category = true;
  }
  if (patch.tags) override.tags = true;
  if (typeof patch.title === "string") override.title = true;
  if (typeof body.todo_due === "string" || body.todo_due === null) {
    extraSets.push("todo_due = ?");
    extraBinds.push(normalizeTodoDue(body.todo_due));
    override.todo_due = true;
  }
  if (Object.keys(override).length > 0) {
    // remember the user's hand-set values so AI triage / cron never overwrites them
    const meta = parseNoteMeta(existing.meta) ?? {};
    meta.manual_override = { ...meta.manual_override, ...override };
    patch.meta = meta;
  }
  if (
    patch.content === undefined &&
    patch.title === undefined &&
    patch.tags === undefined &&
    patch.is_sensitive === undefined &&
    extraSets.length === 0
  )
    return c.json({ error: "no updatable fields" }, 400);

  // CAS on updated_at closes the read→write race window (another device
  // committing between our SELECT and this UPDATE)
  const result = await applyNotePatch(c.env, c.env.DB, existing, patch, { sets: extraSets, binds: extraBinds });
  if (!result.changes) {
    const still = await c.env.DB.prepare(
      "SELECT id FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
    )
      .bind(id, userId)
      .first<{ id: string }>();
    if (still) return conflictResponse(c, id);
    return c.json({ error: "not found" }, 404);
  }
  const note = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
  c.executionCtx.waitUntil(capped(upsertNoteEmbedding(c.env, note!), PIPELINE_TIMEOUT_MS, `patch-embed note=${id}`));
  const sensitivityChanged = result.sensitive !== !!existing.is_sensitive;
  // extractGraph purges graph rows for sensitive notes and (re-)extracts otherwise
  if (typeof body.content === "string" || sensitivityChanged)
    c.executionCtx.waitUntil(capped(extractGraph(c.env, note!), PIPELINE_TIMEOUT_MS, `patch-graph note=${id}`));
  // 新内容疑似含密（fail-closed 预检加密待定论）：立即触发模型复判，
  // 判非敏感时恢复明文，不用等 10 分钟的 cron 扫
  if (result.needsRetriage && note) {
    c.executionCtx.waitUntil(
      capped(
        retriageOne(c.env, { id, user_id: userId, content: note.content, content_enc: note.content_enc, created_at: note.created_at }),
        PIPELINE_TIMEOUT_MS,
        `patch-retriage note=${id}`
      )
    );
  } else if (typeof body.content === "string" && body.content !== existing.content && typeof body.title !== "string") {
    // content changed without an explicit title: recompute the AI title so
    // search/export never keep showing the stale pre-edit title
    c.executionCtx.waitUntil(capped(recomputeTitle(c.env, id, body.content), PIPELINE_TIMEOUT_MS, `patch-title note=${id}`));
  }
  return c.json({ note: await noteToJsonDecrypted(c.env, note!) });
});

/** Regenerate only the AI title after a content edit (never touches category/tags/due). */
export async function recomputeTitle(env: Env, noteId: string, content: string): Promise<void> {
  const row = await env.DB.prepare("SELECT meta, is_sensitive FROM notes WHERE id = ?")
    .bind(noteId)
    .first<{ meta: string | null; is_sensitive: number }>();
  // 敏感笔记的 title 永远保持置空，绝不重算出可能含秘密值的标题
  if (row?.is_sensitive) return;
  if (parseNoteMeta(row?.meta ?? null)?.manual_override?.title) return;
  const triage = await triageNote(content, env);
  if (!triage || !triage.title) return;
  await setNoteAiTitle(env.DB, noteId, triage.title);
}

/** Delete one owned note and its attachments/embedding/graph rows; caller reconciles threads. */
async function deleteNoteRecord(
  env: Env,
  userId: string,
  id: string,
  waitUntil: (p: Promise<unknown>) => void
): Promise<boolean> {
  const note = await env.DB.prepare("SELECT id FROM notes WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ id: string }>();
  if (!note) return false;
  const atts = await env.DB.prepare("SELECT r2_key FROM attachments WHERE note_id = ?")
    .bind(id)
    .all<{ r2_key: string }>();
  await env.DB.prepare("DELETE FROM attachments WHERE note_id = ?").bind(id).run();
  if (env.MEDIA && atts.results.length > 0) {
    waitUntil(
      env.MEDIA.delete(atts.results.map((a) => a.r2_key)).catch((e) =>
        console.error("r2 delete failed", e)
      )
    );
  }
  await deleteNoteEmbedding(env, id);
  await deleteNoteGraph(env, id);
  await env.DB.prepare("DELETE FROM daily_reviews WHERE note_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  return true;
}

const PURGE_BATCH = 200;
/** Wall-clock budget per cron run; keeps well under the 30s cron CPU/duration limits. */
const PURGE_TIME_BUDGET_MS = 20_000;

/** Bulk-delete a batch of notes and their derived data with chunked IN statements. */
async function purgeNotesBatch(
  env: Env,
  ids: string[],
  waitUntil: (p: Promise<unknown>) => void
): Promise<void> {
  for (const chunk of chunkIds(ids)) {
    const ph = chunk.map(() => "?").join(",");
    const atts = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE note_id IN (${ph})`)
      .bind(...chunk)
      .all<{ r2_key: string }>();
    if ((atts.results ?? []).length > 0) {
      await env.DB.prepare(`DELETE FROM attachments WHERE note_id IN (${ph})`).bind(...chunk).run();
      if (env.MEDIA) {
        waitUntil(
          env.MEDIA.delete(atts.results.map((a) => a.r2_key)).catch((e) =>
            console.error("r2 delete failed", e)
          )
        );
      }
    }
    await deleteNoteEmbeddings(env, chunk);
    await deleteNotesGraph(env, chunk);
    await env.DB.prepare(`DELETE FROM daily_reviews WHERE note_id IN (${ph})`).bind(...chunk).run();
    await env.DB.prepare(`DELETE FROM notes WHERE id IN (${ph})`).bind(...chunk).run();
  }
}

/**
 * Hard-delete notes whose soft-delete window has expired, including derived
 * data. Loops batches (oldest deletions first) until the backlog is drained or
 * the time budget is spent, so mass soft-deletes clear within a few cron runs.
 */
export async function purgeExpiredSoftDeletes(
  env: Env,
  ctx: ExecutionContext,
  timeBudgetMs = PURGE_TIME_BUDGET_MS
): Promise<number> {
  const started = Date.now();
  let purged = 0;
  const users = new Set<string>();
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT id, user_id FROM notes WHERE deleted_at IS NOT NULL AND deleted_at <= datetime('now', ?) ORDER BY deleted_at ASC LIMIT ${PURGE_BATCH}`
    )
      .bind(`-${SOFT_DELETE_RETENTION_DAYS} days`)
      .all<{ id: string; user_id: string }>();
    const rows = results ?? [];
    if (rows.length === 0) break;
    for (const row of rows) users.add(row.user_id);
    await purgeNotesBatch(
      env,
      rows.map((r) => r.id),
      (p) => ctx.waitUntil(p)
    );
    purged += rows.length;
    if (rows.length < PURGE_BATCH || Date.now() - started >= timeBudgetMs) break;
  }
  for (const uid of users) await reconcileThreads(env, uid);
  return purged;
}

// ---- DELETE /api/notes/:id ----
// Soft delete: marks deleted_at so undo (restore) survives page reloads; the
// cron sweep hard-deletes rows (and derived data) after the undo window.
app.delete("/api/notes/:id", async (c) => {
  const id = c.req.param("id");
  const res = await c.env.DB.prepare(
    "UPDATE notes SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  )
    .bind(id, c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---- POST /api/notes/restore ----
// Undo a (soft) delete: clears deleted_at for owned, still-unpurged notes.
app.post("/api/notes/restore", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((v): v is string => typeof v === "string") : [];
  if (ids.length === 0) return c.json({ error: "ids required" }, 400);
  if (ids.length > BATCH_MAX_IDS) return c.json({ error: `一次最多恢复 ${BATCH_MAX_IDS} 条` }, 400);
  let restored = 0;
  for (const chunk of chunkIds(ids)) {
    const ph = chunk.map(() => "?").join(",");
    const res = await c.env.DB.prepare(
      `UPDATE notes SET deleted_at = NULL, updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${ph})`
    )
      .bind(userId, ...chunk)
      .run();
    restored += res.meta.changes ?? 0;
  }
  return c.json({ ok: true, restored });
});

/** UTC "YYYY-MM-DD HH:MM:SS" when a soft-deleted note becomes eligible for the purge sweep. */
export function purgeAtOf(deletedAt: string, retentionDays = SOFT_DELETE_RETENTION_DAYS): string | null {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(deletedAt) ? `${deletedAt.replace(" ", "T")}Z` : deletedAt;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + retentionDays * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
}

// ---- GET /api/notes/trash ----
// 最近删除: soft-deleted, not-yet-purged notes, newest deletions first. Each
// item carries purge_at so clients can show the remaining retention time.
app.get("/api/notes/trash", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200"
  )
    .bind(userId)
    .all<NoteRow>();
  const notes = await Promise.all(
    (results ?? []).map(async (n) => ({
      ...(await noteToJsonDecrypted(c.env, n)),
      purge_at: purgeAtOf(n.deleted_at!),
    }))
  );
  return c.json({ notes, retention_days: SOFT_DELETE_RETENTION_DAYS });
});

// ---- POST /api/notes/purge ----
// Immediately hard-delete owned, already soft-deleted notes (and derived data).
app.post("/api/notes/purge", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ ids?: unknown }>().catch(() => null);
  const ids = Array.isArray(body?.ids) ? body.ids.filter((v): v is string => typeof v === "string") : [];
  if (ids.length === 0) return c.json({ error: "ids required" }, 400);
  if (ids.length > BATCH_MAX_IDS) return c.json({ error: `一次最多彻底删除 ${BATCH_MAX_IDS} 条` }, 400);
  const owned: string[] = [];
  for (const chunk of chunkIds(ids)) {
    const ph = chunk.map(() => "?").join(",");
    const r = await c.env.DB.prepare(
      `SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL AND id IN (${ph})`
    )
      .bind(userId, ...chunk)
      .all<{ id: string }>();
    owned.push(...(r.results ?? []).map((x) => x.id));
  }
  if (owned.length > 0) {
    await purgeNotesBatch(c.env, owned, (p) => c.executionCtx.waitUntil(p));
    c.executionCtx.waitUntil(reconcileThreads(c.env, userId));
  }
  return c.json({ ok: true, purged: owned.length });
});

// ---- POST /api/notes/trash/empty ----
// Hard-delete every soft-deleted note the user still has in 最近删除.
app.post("/api/notes/trash/empty", async (c) => {
  const userId = c.get("userId");
  let purged = 0;
  for (;;) {
    const { results } = await c.env.DB.prepare(
      `SELECT id FROM notes WHERE user_id = ? AND deleted_at IS NOT NULL LIMIT ${PURGE_BATCH}`
    )
      .bind(userId)
      .all<{ id: string }>();
    const rows = results ?? [];
    if (rows.length === 0) break;
    await purgeNotesBatch(
      c.env,
      rows.map((r) => r.id),
      (p) => c.executionCtx.waitUntil(p)
    );
    purged += rows.length;
    if (rows.length < PURGE_BATCH) break;
  }
  if (purged > 0) c.executionCtx.waitUntil(reconcileThreads(c.env, userId));
  return c.json({ ok: true, purged });
});

// ---- POST /api/notes/batch ----
// Bulk operations over owned notes: delete / add_tags / remove_tags / set_category.
// Targets are either explicit `ids` or a server-side `filter` ({category, tag, q})
// that matches ALL notes satisfying the current list filters, not only loaded ones.
const BATCH_MAX_IDS = 1000;
const BATCH_FILTER_MAX = 1000;

// D1 caps bound parameters per statement: id lists are chunked
function chunkIds<T>(arr: T[], size = 80): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Resolve a batch `filter` into the matching note ids (same semantics as
 * GET /api/notes), plus the total match count so callers can report how many
 * matches remain beyond the BATCH_FILTER_MAX cap.
 */
export async function resolveBatchFilter(
  env: Env,
  userId: string,
  filter: { category?: unknown; tag?: unknown; q?: unknown; source?: unknown; from?: unknown; to?: unknown }
): Promise<{ ids: string[]; total: number }> {
  const f = noteFilterConds(filter);
  const conds: string[] = ["user_id = ?", ...f.conds];
  const binds: unknown[] = [userId, ...f.binds];
  const where = conds.join(" AND ");
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notes WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const { results } = await env.DB.prepare(
    `SELECT id FROM notes WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ${BATCH_FILTER_MAX}`
  )
    .bind(...binds)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => r.id);
  return { ids, total: count?.n ?? ids.length };
}

/** Max statements per D1 batch() call in bulk mutations. */
const BATCH_STMTS_PER_CALL = 100;

/**
 * Run a batch action, reporting progress as work completes. Returns the
 * affected count plus the ids of notes actually changed (tag actions), so
 * clients can offer precise undo.
 *
 * D1 roundtrips dominate wall time (each can intermittently take seconds), so
 * reads run in parallel and mutations go through few large batch() calls
 * instead of 2 sequential roundtrips per 80-id chunk.
 */
async function runBatchAction(
  env: Env,
  userId: string,
  action: string,
  ids: string[],
  opts: { tags: string[]; category: string },
  onProgress?: (done: number, total: number) => void
): Promise<{ affected: number; changedIds: string[] }> {
  const started = Date.now();
  const chunks = chunkIds(ids);
  let affected = 0;
  const changedIds: string[] = [];
  if (action === "delete") {
    // soft delete: all chunk UPDATEs in one batch() roundtrip; the cron sweep
    // hard-deletes (and cleans attachments/vectors/graph) after the undo window
    const stmts = chunks.map((chunk) =>
      env.DB.prepare(
        `UPDATE notes SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`
      ).bind(userId, ...chunk)
    );
    for (const res of await env.DB.batch(stmts)) affected += (res.meta as { changes?: number })?.changes ?? 0;
    onProgress?.(ids.length, ids.length);
  } else if (action === "add_tags" || action === "remove_tags" || action === "set_category") {
    const selected = await Promise.all(
      chunks.map((chunk) =>
        env.DB.prepare(
          `SELECT id, tags, meta, is_sensitive FROM notes WHERE user_id = ? AND deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(",")})`
        )
          .bind(userId, ...chunk)
          .all<{ id: string; tags: string; meta: string | null; is_sensitive: number }>()
      )
    );
    const stmts: D1PreparedStatement[] = [];
    for (const row of selected.flatMap((r) => r.results ?? [])) {
      const meta = parseNoteMeta(row.meta) ?? {};
      if (action === "set_category") {
        meta.manual_override = { ...meta.manual_override, category: true };
        stmts.push(
          env.DB.prepare(
            "UPDATE notes SET category = ?, meta = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
          ).bind(opts.category, JSON.stringify(meta), row.id, userId)
        );
      } else {
        let current: string[] = [];
        try {
          current = JSON.parse(row.tags || "[]") as string[];
        } catch {
          current = [];
        }
        const next =
          action === "add_tags"
            ? [...new Set([...current, ...opts.tags])]
            : current.filter((t) => !opts.tags.includes(t));
        if (next.length === current.length && next.every((t, i) => t === current[i])) continue;
        meta.manual_override = { ...meta.manual_override, tags: true };
        // 敏感行的 tags 在持久层统一过严格过滤（R123 P1：批量打标曾能把秘密值写进敏感笔记的 tags）
        stmts.push(prepareTagsUpdate(env.DB, { id: row.id, user_id: userId, is_sensitive: row.is_sensitive }, next, meta));
      }
      changedIds.push(row.id);
    }
    // untouched notes (missing / already in target state) count as processed
    let done = ids.length - stmts.length;
    onProgress?.(done, ids.length);
    for (let i = 0; i < stmts.length; i += BATCH_STMTS_PER_CALL) {
      const slice = stmts.slice(i, i + BATCH_STMTS_PER_CALL);
      await env.DB.batch(slice);
      affected += slice.length;
      done += slice.length;
      onProgress?.(done, ids.length);
    }
  }
  console.log(`notes/batch ${action}: ids=${ids.length} affected=${affected} ${Date.now() - started}ms`);
  return { affected, changedIds };
}

app.post("/api/notes/batch", async (c) => {
  const userId = c.get("userId");
  const body = await c.req
    .json<{ action?: unknown; ids?: unknown; tags?: unknown; category?: unknown; filter?: unknown }>()
    .catch(() => null);
  if (!body) return c.json({ error: "invalid body" }, 400);
  const action = body.action;
  if (action !== "delete" && action !== "add_tags" && action !== "remove_tags" && action !== "set_category")
    return c.json({ error: "invalid action" }, 400);
  // 批量写操作同样限频（R123 P2：batch 曾完全不限流）
  if (!(await checkRateLimit(c.env.DB, "batch_write", [userId], BATCH_WRITE_RATE_LIMIT_MAX))) {
    return c.json({ error: "批量操作太频繁了，请稍等一分钟再试", retryable: true }, 429);
  }
  let ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === "string") : [];
  const filter = body.filter && typeof body.filter === "object" ? (body.filter as Record<string, unknown>) : null;
  // matches beyond the BATCH_FILTER_MAX cap; lets the UI say "N more remain"
  let remaining = 0;
  if (ids.length === 0 && filter) {
    const resolved = await resolveBatchFilter(c.env, userId, filter);
    ids = resolved.ids;
    remaining = Math.max(0, resolved.total - ids.length);
    if (ids.length === 0) return c.json({ ok: true, affected: 0, remaining: 0 });
  } else {
    if (ids.length === 0) return c.json({ error: "ids or filter required" }, 400);
    if (ids.length > BATCH_MAX_IDS) return c.json({ error: `一次最多操作 ${BATCH_MAX_IDS} 条` }, 400);
  }

  const tags = Array.isArray(body.tags)
    ? body.tags.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((t) => t.trim())
    : [];
  if ((action === "add_tags" || action === "remove_tags") && tags.length === 0)
    return c.json({ error: "tags required" }, 400);
  const category = typeof body.category === "string" ? body.category : "";
  if (action === "set_category" && !["idea", "todo", "collect", "data", "expense", "income", "transfer"].includes(category))
    return c.json({ error: "invalid category" }, 400);
  const opts = { tags, category };

  // ?stream=1: NDJSON progress lines ({"done","total"}) followed by a final
  // {ok, affected} line (or {error}); keeps big batches responsive in the UI.
  if (c.req.query("stream") === "1") {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const writeLine = (obj: unknown) => writer.write(enc.encode(`${JSON.stringify(obj)}\n`)).catch(() => {});
    const run = (async () => {
      try {
        await writeLine({ done: 0, total: ids.length });
        const { affected, changedIds } = await runBatchAction(c.env, userId, action, ids, opts, (done, total) =>
          void writeLine({ done, total })
        );
        // delete echoes the targeted ids, tag actions the actually-changed ids,
        // so the client can offer undo (restore / inverse tag op)
        await writeLine(
          action === "delete"
            ? { ok: true, affected, remaining, ids }
            : action === "add_tags" || action === "remove_tags"
              ? { ok: true, affected, remaining, ids: changedIds }
              : { ok: true, affected, remaining }
        );
      } catch (e) {
        console.error("batch stream failed", e);
        await writeLine({ error: e instanceof Error ? e.message : "批量操作失败" });
      } finally {
        await writer.close().catch(() => {});
      }
    })();
    c.executionCtx.waitUntil(run);
    return c.body(readable, 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-transform",
      "content-encoding": "identity",
    });
  }

  const { affected, changedIds } = await runBatchAction(c.env, userId, action, ids, opts);
  // delete echoes the targeted ids, tag actions the actually-changed ids, for undo
  return c.json(
    action === "delete"
      ? { ok: true, affected, remaining, ids }
      : action === "add_tags" || action === "remove_tags"
        ? { ok: true, affected, remaining, ids: changedIds }
        : { ok: true, affected, remaining }
  );
});

// ---- GET /api/tags ----
// All tags of the current user with usage counts, most used first.
// ---- GET /api/stats ----
// One-shot dashboard stats: heatmap daily counts, totals, distributions,
// streaks, top tags, thread count. tz_offset = minutes east of UTC (default +480).
app.get("/api/stats", async (c) => {
  const days = Math.max(1, Math.min(730, parseInt(c.req.query("days") ?? "", 10) || 365));
  const tzOffset = normalizeTzOffset(c.req.query("tz_offset"));
  // 自定义洞察范围（借鉴 flomo）：tag 按标签过滤，scope_days 只统计最近 N 天
  const tag = (c.req.query("tag") ?? "").trim().slice(0, 50) || undefined;
  const scopeDaysRaw = parseInt(c.req.query("scope_days") ?? "", 10);
  const scopeDays = scopeDaysRaw > 0 ? Math.min(3650, scopeDaysRaw) : undefined;
  const stats = await buildStats(c.env, c.get("userId"), { days, tzOffset, tag, scopeDays });
  return c.json(stats);
});

// ---- GET /api/notes/random ----
// 随机漫步: one random historical note, never sensitive/sample/soft-deleted.
app.get("/api/notes/random", async (c) => {
  const note = await c.env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL AND is_sensitive = 0 AND tags NOT LIKE '${SAMPLE_TAG_LIKE}' ORDER BY RANDOM() LIMIT 1`
  )
    .bind(c.get("userId"))
    .first<NoteRow>();
  if (!note) return c.json({ error: "暂无可回看的笔记" }, 404);
  const [withAtt] = await withAttachments(c.env, [noteToJson(note)]);
  return c.json({ note: withAtt });
});

app.get("/api/tags", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare("SELECT tags FROM notes WHERE user_id = ? AND deleted_at IS NULL")
    .bind(userId)
    .all<{ tags: string }>();
  const counts = new Map<string, number>();
  for (const r of results ?? []) {
    try {
      for (const t of JSON.parse(r.tags || "[]") as string[]) {
        if (typeof t === "string" && t) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    } catch {
      /* ignore bad rows */
    }
  }
  const tags = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
  return c.json({ tags });
});

/** Replace/remove a tag across all of a user's notes; `to = null` removes it. Returns affected note count. */
async function retagUser(env: Env, userId: string, from: string, to: string | null): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, tags, is_sensitive FROM notes WHERE user_id = ? AND deleted_at IS NULL AND tags LIKE ?"
  )
    .bind(userId, `%"${from}"%`)
    .all<{ id: string; tags: string; is_sensitive: number }>();
  let affected = 0;
  for (const row of results ?? []) {
    let current: string[] = [];
    try {
      current = JSON.parse(row.tags || "[]") as string[];
    } catch {
      continue;
    }
    if (!current.includes(from)) continue; // LIKE can over-match substrings
    const next = [...new Set(current.map((t) => (t === from ? to : t)).filter((t): t is string => t !== null))];
    await prepareTagsUpdate(env.DB, { id: row.id, user_id: userId, is_sensitive: row.is_sensitive }, next).run();
    affected++;
  }
  return affected;
}

const MAX_TAG_CHARS = 32;

// ---- POST /api/tags/rename ----
// Rename a tag on every note; renaming onto an existing tag merges them.
app.post("/api/tags/rename", async (c) => {
  const body = await c.req.json<{ from?: unknown; to?: unknown }>().catch(() => null);
  const from = typeof body?.from === "string" ? body.from.trim() : "";
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!from || !to) return c.json({ error: "from/to required" }, 400);
  if (to.length > MAX_TAG_CHARS) return c.json({ error: `标签最长 ${MAX_TAG_CHARS} 个字符` }, 400);
  if (from === to) return c.json({ ok: true, affected: 0 });
  const affected = await retagUser(c.env, c.get("userId"), from, to);
  return c.json({ ok: true, affected });
});

// ---- POST /api/tags/delete ----
// Remove a tag from every note of the current user.
app.post("/api/tags/delete", async (c) => {
  const body = await c.req.json<{ tag?: unknown }>().catch(() => null);
  const tag = typeof body?.tag === "string" ? body.tag.trim() : "";
  if (!tag) return c.json({ error: "tag required" }, 400);
  const affected = await retagUser(c.env, c.get("userId"), tag, null);
  return c.json({ ok: true, affected });
});

// ---- POST /api/notes/:id/refetch-link ----
// Manual retry of link title + article extraction for a link note.
app.post("/api/notes/:id/refetch-link", async (c) => {
  const id = c.req.param("id");
  const note = await c.env.DB.prepare("SELECT id, url FROM notes WHERE id = ? AND user_id = ?")
    .bind(id, c.get("userId"))
    .first<{ id: string; url: string | null }>();
  if (!note) return c.json({ error: "not found" }, 404);
  if (!note.url) return c.json({ error: "not a link note" }, 400);
  await fetchLinkMetaInto(c.env, id, [note.url]);
  await enrichLinkInto(c.env, id);
  const updated = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
  return c.json({ note: await noteToJsonDecrypted(c.env, updated!) });
});

// ---- POST /api/notes/:id/retry-media ----
// In-place retry of transcription/extraction for a failed voice/image/file
// note (R109 P2-4): re-runs the extractor on the R2-archived original, so the
// user never has to re-upload. On success the note re-enters the normal async
// triage pipeline with the real content.
app.post("/api/notes/:id/retry-media", async (c) => {
  const id = c.req.param("id");
  const note = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL")
    .bind(id, c.get("userId"))
    .first<NoteRow>();
  if (!note) return c.json({ error: "not found" }, 404);
  const meta = parseNoteMeta(note.meta) ?? {};
  const failed =
    (note.raw_type === "file" && meta.file_status === "extract_failed") ||
    ((note.raw_type === "voice" || note.raw_type === "image") &&
      (meta.media_status === "extract_failed" ||
        note.content.startsWith(AUDIO_FAILED_PLACEHOLDER) ||
        note.content.startsWith(IMAGE_FAILED_PLACEHOLDER)));
  if (!failed) return c.json({ error: "该笔记无需重试" }, 400);
  if (!c.env.MEDIA) return c.json({ error: "media storage not configured" }, 404);
  const att = await c.env.DB.prepare("SELECT r2_key, mime FROM attachments WHERE note_id = ? ORDER BY rowid DESC LIMIT 1")
    .bind(id)
    .first<{ r2_key: string; mime: string | null }>();
  const obj = att ? await c.env.MEDIA.get(att.r2_key) : null;
  if (!obj) return c.json({ error: "原件未存档，无法原地重试，请重新上传" }, 404);
  const bytes = new Uint8Array(await obj.arrayBuffer());

  let content: string | null = null;
  const newMeta: NoteMeta = { ...meta };
  if (note.raw_type === "voice") {
    const raw = await transcribeAudio(c.env, bytes);
    if (raw !== null) {
      const corrected = await correctTranscript(c.env, raw);
      content = corrected;
      if (corrected !== raw) newMeta.raw_transcript = raw;
      newMeta.media_status = "ok";
    }
  } else if (note.raw_type === "image") {
    const extraction = await describeImage(c.env, bytes);
    if (extraction !== null) {
      content = extraction.content;
      if (extraction.description && extraction.description !== extraction.content) {
        newMeta.image_description = extraction.description;
      }
      newMeta.media_status = "ok";
    }
  } else {
    const kind = detectFileKind(meta.file_name, meta.file_mime ?? att!.mime ?? "");
    if (!kind) return c.json({ error: "不支持的文件类型" }, 400);
    const result = await buildFileNote(c.env, kind, meta.file_name || "file", bytes);
    if (result.extracted) {
      content = result.content;
      newMeta.file_status = "ok";
      if (result.excerpt) newMeta.file_excerpt = result.excerpt;
    }
  }
  if (content === null) {
    return c.json({ error: "重试仍然失败，原件已保留，可稍后再试", retryable: true }, 502);
  }

  // same fail-closed sensitive pre-check as createNote (持久层内置）；category
  // back to NULL: the placeholder's triage is meaningless for the real
  // content — the async pipeline below re-sorts it like a fresh note
  const { storedContent, contentEnc } = await replaceNoteContent(c.env, c.env.DB, id, content, newMeta);
  c.executionCtx.waitUntil(
    capped(
      retriageOne(c.env, { id, user_id: note.user_id, content: storedContent, content_enc: contentEnc, created_at: note.created_at }),
      PIPELINE_TIMEOUT_MS,
      `retry-media note=${id}`
    )
  );
  const updated = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
  return c.json({ note: await noteToJsonDecrypted(c.env, updated!) });
});

// ---- GET /api/notes/:id/file ----
// Proxy-download the original attachment from R2 (owner-only; bearer auth
// already enforced by the /api/* middleware).
app.get("/api/notes/:id/file", async (c) => {
  const id = c.req.param("id");
  const note = await c.env.DB.prepare("SELECT id, meta FROM notes WHERE id = ? AND user_id = ?")
    .bind(id, c.get("userId"))
    .first<{ id: string; meta: string | null }>();
  if (!note) return c.json({ error: "not found" }, 404);
  if (!c.env.MEDIA) return c.json({ error: "media storage not configured" }, 404);
  // ?att=<attachment id> selects a specific attachment (imported notes can
  // carry several); default stays the newest one. Ownership is enforced via
  // the note_id join above — an att id from another user's note 404s.
  const attId = c.req.query("att");
  const att = attId
    ? await c.env.DB.prepare("SELECT r2_key, mime FROM attachments WHERE id = ? AND note_id = ?")
        .bind(attId, id)
        .first<{ r2_key: string; mime: string | null }>()
    : await c.env.DB.prepare("SELECT r2_key, mime FROM attachments WHERE note_id = ? ORDER BY rowid DESC LIMIT 1")
        .bind(id)
        .first<{ r2_key: string; mime: string | null }>();
  if (!att) return c.json({ error: "no attachment" }, 404);
  const obj = await c.env.MEDIA.get(att.r2_key);
  if (!obj) return c.json({ error: "attachment missing" }, 404);
  const fileName = parseNoteMeta(note.meta)?.file_name || att.r2_key.split("/").pop() || "file";
  const mime = att.mime || obj.httpMetadata?.contentType || "application/octet-stream";
  // inline rendering (R144 P1-1) only for safe media types the clients embed
  // (<img>/<audio>); everything else keeps forced download semantics
  const inline = c.req.query("inline") === "1" && /^(image|audio|video)\//.test(mime);
  return new Response(obj.body, {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(obj.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
    },
  });
});

// ---- POST /api/ingest/wechat ----
app.post("/api/ingest/wechat", async (c) => {
  const body = await c.req
    .json<{ content?: string; url?: string; raw_type?: string; skip_triage?: boolean; tags?: string[] }>()
    .catch(() => null);
  if (!body || !(body.content ?? "").trim()) return c.json({ error: "content required" }, 400);
  const tooLong = contentTooLong(c, body.content ?? "");
  if (tooLong) return tooLong;
  // 同一 note_write 限额覆盖所有单笔 AI 入库入口（R122 P1-5）；放在入参校验之后，
  // 非法请求不消耗配额
  if (!(await checkRateLimit(c.env.DB, "note_write", [c.get("userId")], NOTE_WRITE_RATE_LIMIT_MAX))) {
    return c.json({ error: "写入太频繁了，请稍等一分钟再试", retryable: true }, 429);
  }
  const skipTriage = body.skip_triage === true;
  // wechat needs the category/tags in its confirmation text -> triage stays synchronous
  const { note, triage: triageResult } = await createNote(
    c,
    c.get("userId"),
    { ...body, source: "wechat" },
    (p) => c.executionCtx.waitUntil(p),
    { syncTriage: true, skipTriage }
  );
  const noteTags = JSON.parse(note.tags || "[]") as string[];
  let reply: string;
  if (skipTriage) {
    const tagStr = noteTags.map((t) => `#${t}`).join(" ");
    reply = `已存（未分拣）${tagStr ? " " + tagStr : ""}`;
  } else {
    const triage = triageResult ?? FALLBACK_TRIAGE;
    const label = CATEGORY_LABEL[triage.category] ?? triage.category;
    const tagStr = (noteTags.length > 0 ? noteTags : triage.tags).map((t) => `#${t}`).join(" ");
    reply = `已存 · ${label}${tagStr ? " " + tagStr : ""}`;
  }
  return c.json({ note: await noteToJsonDecrypted(c.env, note), reply }, 201);
});

// ---- POST /api/bridge/heartbeat ----
// The VPS bridge reports its login state every minute; /health?probe=bridge
// (and UptimeRobot on it) reads this row, so a missing/stale heartbeat means
// the bridge is down and "waiting_scan" means the boss needs to re-scan.
app.post("/api/bridge/heartbeat", async (c) => {
  const body = await c.req.json<{ status?: unknown; detail?: unknown }>().catch(() => null);
  const status = typeof body?.status === "string" && BRIDGE_STATUSES.has(body.status) ? body.status : null;
  if (!status) return c.json({ error: "status must be one of: " + [...BRIDGE_STATUSES].join("/") }, 400);
  const detail = typeof body?.detail === "string" ? body.detail.slice(0, 200) : undefined;
  await writeCronHeartbeat(c.env, "wechat_bridge", "bridge", { status, ...(detail ? { detail } : {}) });
  return c.json({ ok: true });
});

// ---- WeChat binding (authed; shared by 公众号 and 企微客服 channels) ----
// POST /api/wechat/bind-code: generate a fresh 6-digit binding code
app.post("/api/wechat/bind-code", async (c) => {
  if (!c.env.WECHAT_MP_TOKEN && !wecomKfConfigured(c.env)) return c.json({ error: "微信通道未配置" , code: "MP_NOT_CONFIGURED" }, 404);
  const { code, expires_at } = await createBindCode(c.env.DB, c.get("userId"));
  return c.json({ code, expires_at, ttl_minutes: BIND_CODE_TTL_MINUTES }, 201);
});

// GET /api/wechat/binding: current binding status
app.get("/api/wechat/binding", async (c) => {
  const configured = !!c.env.WECHAT_MP_TOKEN;
  const kfConfigured = wecomKfConfigured(c.env);
  const mask = (id: string) => (id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);
  const rows = await c.env.DB.prepare(
    "SELECT openid, created_at FROM wechat_mp_bindings WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(c.get("userId"))
    .all<{ openid: string; created_at: string }>();
  // openid is an opaque WeChat identifier but still masked to avoid leaking it wholesale
  const bindings = (rows.results ?? []).map((r) => ({
    openid_masked: mask(r.openid),
    created_at: r.created_at,
  }));
  const kfRows = await c.env.DB.prepare(
    "SELECT external_userid, created_at FROM wecom_kf_bindings WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(c.get("userId"))
    .all<{ external_userid: string; created_at: string }>();
  const kfBindings = (kfRows.results ?? []).map((r) => ({
    openid_masked: mask(r.external_userid),
    created_at: r.created_at,
  }));
  return c.json({
    configured,
    bound: bindings.length > 0,
    bindings,
    kf_configured: kfConfigured,
    kf_bound: kfBindings.length > 0,
    kf_bindings: kfBindings,
  });
});

// DELETE /api/wechat/binding: unbind all WeChat accounts (公众号 + 客服) for this user
app.delete("/api/wechat/binding", async (c) => {
  await c.env.DB.prepare("DELETE FROM wechat_mp_bindings WHERE user_id = ?").bind(c.get("userId")).run();
  await c.env.DB.prepare("DELETE FROM wecom_kf_bindings WHERE user_id = ?").bind(c.get("userId")).run();
  await c.env.DB.prepare("DELETE FROM wechat_mp_bind_codes WHERE user_id = ?").bind(c.get("userId")).run();
  return c.json({ ok: true });
});

// ---- POST /api/ingest/media ----
// audio -> Whisper transcription, image -> vision text extraction, file ->
// text extraction (+ AI summary for long docs); the extracted text becomes
// the note content and flows through the normal async triage pipeline.
app.post("/api/ingest/media", async (c) => {
  // 同一 note_write 限额覆盖所有单笔 AI 入库入口（R122 P1-5）
  if (!(await checkRateLimit(c.env.DB, "note_write", [c.get("userId")], NOTE_WRITE_RATE_LIMIT_MAX))) {
    return c.json({ error: "写入太频繁了，请稍等一分钟再试", retryable: true }, 429);
  }
  const parsed = await parseMediaRequest(c.req.raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status);

  // 幂等：同一 client_id 的补传重放（响应丢失后 outbox 重发）返回已建笔记，
  // 不重复转写建新笔记
  if (parsed.clientId) {
    const dup = await c.env.DB.prepare(
      "SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL AND json_extract(meta, '$.client_id') = ? LIMIT 1"
    )
      .bind(c.get("userId"), parsed.clientId)
      .first<NoteRow>();
    if (dup) {
      return c.json({ note: noteToJson(dup), text: dup.content, transcribed: true, reply: "已记录（重复补传，返回已有笔记）" }, 200);
    }
  }

  if (parsed.type === "file") {
    const fileName = parsed.fileName || "file";
    const kind = detectFileKind(parsed.fileName, parsed.mime);
    if (!kind) {
      return c.json({ error: "不支持的文件类型：目前支持 PDF / txt / md / docx" }, 400);
    }
    const result = await buildFileNote(c.env, kind, fileName, parsed.bytes);
    const tooLongFile = contentTooLong(c, result.content);
    if (tooLongFile) return tooLongFile;
    const meta: NoteMeta = {
      ...(parsed.clientId ? { client_id: parsed.clientId } : {}),
      file_name: fileName,
      file_mime: parsed.mime,
      file_size: parsed.bytes.length,
      file_kind: kind,
      file_status: result.extracted ? "ok" : "extract_failed",
      ...(result.excerpt ? { file_excerpt: result.excerpt } : {}),
    };
    const { note } = await createNote(
      c,
      c.get("userId"),
      { source: parsed.source || "api", raw_type: "file", content: result.content, meta },
      (p) => c.executionCtx.waitUntil(p),
      { syncTriage: false }
    );
    // 原件必须存档成功（下载依赖 R2），失败则同步等待并如实报错
    const r2Key = await storeOriginal(c.env, c.get("userId"), note.id, parsed);
    if (!r2Key && c.env.MEDIA) console.error("file ingest: R2 archive failed for note", note.id);
    const reply = buildFileReply(fileName, result.content, result.extracted);
    return c.json({ note: noteToJson(note), text: result.content, extracted: result.extracted, reply }, 201);
  }

  let content: string | null = null;
  let meta: NoteMeta | null = null;
  if (parsed.type === "audio") {
    const raw = await transcribeAudio(c.env, parsed.bytes);
    if (raw !== null) {
      const corrected = await correctTranscript(c.env, raw);
      content = corrected;
      if (corrected !== raw) meta = { raw_transcript: raw };
    }
  } else {
    const extraction = await describeImage(c.env, parsed.bytes);
    if (extraction !== null) {
      content = extraction.content;
      if (extraction.description && extraction.description !== extraction.content) {
        meta = { image_description: extraction.description };
      }
    }
  }
  const ok = content !== null;
  if (content === null) {
    content = `${parsed.type === "audio" ? AUDIO_FAILED_PLACEHOLDER : IMAGE_FAILED_PLACEHOLDER}${parsed.fileName ? `（${parsed.fileName}）` : ""}`;
    // explicit failure marker: the client offers an in-place retry (original
    // is archived in R2), no re-upload needed
    meta = { ...(meta ?? {}), media_status: "extract_failed" };
  }

  const tooLong = contentTooLong(c, content);
  if (tooLong) return tooLong;

  if (parsed.clientId) meta = { ...(meta ?? {}), client_id: parsed.clientId };
  const { note } = await createNote(
    c,
    c.get("userId"),
    { source: parsed.source || "api", raw_type: parsed.type === "audio" ? "voice" : "image", content, meta },
    (p) => c.executionCtx.waitUntil(p),
    { syncTriage: false }
  );
  // keep the original in R2 (best-effort; extraction result is already saved)
  c.executionCtx.waitUntil(storeOriginal(c.env, c.get("userId"), note.id, parsed));

  const reply = buildMediaReply(parsed.type, content, ok);
  return c.json({ note: noteToJson(note), text: content, transcribed: ok, reply }, 201);
});

export type AskHistoryMessage = { role: "user" | "assistant"; content: string };

const ASK_HISTORY_MAX_MESSAGES = 6; // 最近 3 轮
const ASK_HISTORY_MAX_CHARS = 2000;

/** Validate the optional multi-turn `history` param: keep only well-formed recent messages. */
export function sanitizeAskHistory(raw: unknown): AskHistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const msgs: AskHistoryMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      msgs.push({ role, content: content.trim().slice(0, ASK_HISTORY_MAX_CHARS) });
    }
  }
  return msgs.slice(-ASK_HISTORY_MAX_MESSAGES);
}

// D1 rejects LIKE patterns over ~50 bytes ("pattern too complex"), so cap each term's UTF-8 length.
function capBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  while (s.length > 0 && enc.encode(s).length > max) s = s.slice(0, -1);
  return s;
}

/**
 * Recall keywords for /api/ask: terms from the current question come first,
 * then terms from the last two user turns of history (so follow-up questions
 * using pronouns still recall notes about the earlier topic).
 */
export function extractAskTerms(question: string, history: AskHistoryMessage[]): string[] {
  const split = (s: string) =>
    s
      .split(/[\s,，。？?！!、;；:：]+/)
      .map((t) => capBytes(t.trim(), 45))
      .filter((t) => t.length >= 2);
  const terms: string[] = [];
  const push = (t: string) => {
    if (!terms.includes(t) && terms.length < 6) terms.push(t);
  };
  for (const t of split(question)) push(t);
  const recentUser = history.filter((m) => m.role === "user").slice(-2);
  for (const m of recentUser) for (const t of split(m.content)) push(t);
  return terms;
}

const CJK_RE = /[\u4e00-\u9fff]/;

/**
 * Whether naive punctuation-splitting failed to produce usable recall terms:
 * long unsegmented CJK questions come out as whole clauses ("最近几天收藏的那
 * 个咖啡视频讲什么") that never LIKE-match any note. Such questions need LLM
 * keyword extraction before keyword recall.
 */
export function needsCjkKeywordExtraction(terms: string[]): boolean {
  return terms.length === 0 || terms.some((t) => CJK_RE.test(t) && !/\s/.test(t) && t.length >= 8);
}

/**
 * Non-CJK (e.g. English) questions rarely LIKE-match mostly-Chinese notes:
 * such questions go through LLM keyword extraction too, which emits both the
 * original-language keywords and their Chinese equivalents.
 */
export function needsBilingualKeywordExtraction(question: string): boolean {
  return !CJK_RE.test(question) && /[a-zA-Z]/.test(question);
}

const ASK_KEYWORDS_SYSTEM =
  "你是检索关键词抽取器。从问题中抽取 2-6 个最能定位相关笔记的关键词（具体的名词、动词或专有名词，每个 2-6 个字），用空格分隔输出，不要任何标点、解释或前缀。问题里的具体数字/金额/价格/型号/电话等细节词（如「8.5元」「iPhone 15」）也是关键词，要保留其核心词（如「报价」「8.5」）。忽略疑问词（什么/哪个/怎么/是啥/what/which/how）、时间词（今天/最近几天/上个月/去年/recently/last week）、代词和语气助词。若问题含英文词，除英文关键词外还要同时输出其中文对应词（因为笔记多为中文）。例如「最近几天收藏的那个咖啡视频讲什么」输出「咖啡 视频 收藏」；「What did I note about the coffee shop idea」输出「coffee shop 咖啡馆 点子」。";

/**
 * LLM keyword extraction for unsegmented CJK questions (query-rewrite stage):
 * returns 0-6 short terms usable as LIKE recall keywords. Returns [] when the
 * AI is unavailable or the output is unusable — callers keep the naive terms.
 */
export async function extractAskKeywords(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  question: string
): Promise<string[]> {
  const out = await chatComplete(env, {
    temperature: 0,
    max_tokens: 100,
    timeout_ms: 10_000,
    messages: [
      { role: "system", content: ASK_KEYWORDS_SYSTEM },
      { role: "user", content: question },
    ],
  });
  if (!out) return [];
  return out
    .trim()
    .split(/[\s,，、。/|;；:：]+/)
    .map((t) => capBytes(t.trim(), 45))
    .filter((t) => t.length >= 2 && t.length <= 12)
    .slice(0, 6);
}

const ASK_REWRITE_SYSTEM =
  "你是检索查询改写器。把用户在多轮对话中的最后一个问题改写为不依赖上下文、可独立理解的完整问题：把代词（它/这个/那个/他们）和序数词（第一个/第二个/最后一个）替换为前文对应的具体事物，补全省略的主语和话题。只输出改写后的问题本身，不要任何解释或前缀。若问题本身已完整，原样输出。";

/**
 * Rewrite a follow-up question into a standalone one (query rewrite) so keyword
 * recall works for pronoun/ordinal follow-ups ("第二个什么时候截止"). Falls back
 * to the original question when there is no history or the AI is unavailable.
 */
export async function rewriteAskQuestion(
  env: Pick<Env, "AI" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_MODEL" | "AI_BASE_URL">,
  question: string,
  history: AskHistoryMessage[]
): Promise<string> {
  if (history.length === 0) return question;
  const rewritten = await chatComplete(env, {
    temperature: 0,
    max_tokens: 200,
    timeout_ms: 15_000,
    messages: [{ role: "system", content: ASK_REWRITE_SYSTEM }, ...history, { role: "user", content: question }],
  });
  const out = rewritten?.trim();
  if (!out || out.length > 300) return question;
  return out;
}

/**
 * How many encrypted sensitive notes match the recall terms. Only searchable
 * metadata fields are matched (content of sensitive notes is a placeholder);
 * neither titles nor content ever leave the database here — just a count.
 */
async function countSensitiveHits(env: Env, userId: string, terms: string[]): Promise<number> {
  if (terms.length === 0) return 0;
  try {
    const ors = terms.map(() => "(title LIKE ? OR tags LIKE ? OR url_title LIKE ?)");
    const binds: unknown[] = [userId];
    for (const t of terms) {
      const like = `%${t}%`;
      binds.push(like, like, like);
    }
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notes WHERE user_id = ? AND is_sensitive = 1 AND deleted_at IS NULL AND (${ors.join(" OR ")})`
    )
      .bind(...binds)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

// ---- POST /api/ask ----
app.post("/api/ask", async (c) => {
  const userId = c.get("userId");
  // ask is the most expensive authenticated endpoint (several LLM calls per
  // question): a per-user cap bounds cost from a leaked token or runaway client
  if (!(await checkRateLimit(c.env.DB, "ask", [userId], ASK_RATE_LIMIT_MAX))) {
    return c.json({ error: "提问太频繁了，请稍等一分钟再试", retryable: true }, 429);
  }
  const body = await c.req.json<{ question?: string; history?: unknown; graph?: unknown }>().catch(() => null);
  const question = (body?.question ?? "").trim();
  if (!question) return c.json({ error: "question required" }, 400);
  const history = sanitizeAskHistory(body?.history);
  const useGraph = body?.graph !== false; // graph:false disables GraphRAG expansion (A/B comparison)

  // query rewrite: resolve pronouns/ordinals against history, then keyword recall
  const recallQuestion = await rewriteAskQuestion(c.env, question, history);
  // explicit time scope ("上个月/最近一周/去年…") narrows recall to that window
  const timeRange = parseTimeRange(recallQuestion);
  // 财务/统计合计类问题走精确聚合（与周报/月报同一 financeStats 口径），
  // 绝不让 LLM 对被 LIMIT 截断的召回结果心算合计（R107 P1-2）。
  // 财务口径澄清追问（R130 P2-1）：上一轮是精确合计时，「包括报销的差旅费
  // 吗」应直答是/否+口径解释（按 category 判定计入与否），绝不复读合计（R129 R14）。
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content ?? null;
  const clarifyTerms = financeClarifyTerms(question, lastAssistant);
  if (clarifyTerms) {
    // 时间范围优先取本轮问题，否则沿用上一轮合计答案里的时间短语（口径一致）
    const clRange = parseTimeRange(question) ?? timeRange ?? parseTimeRange(lastAssistant ?? "");
    const ors = clarifyTerms.map(() => "(content LIKE ? OR title LIKE ? OR tags LIKE ?)").join(" OR ");
    const clConds = ["user_id = ?", "deleted_at IS NULL", "category IN ('expense','income','transfer')", `(${ors})`];
    const clBinds: unknown[] = [userId];
    for (const t of clarifyTerms) {
      const like = `%${t}%`;
      clBinds.push(like, like, like);
    }
    if (clRange?.start) {
      clConds.push("created_at >= ?");
      clBinds.push(clRange.start);
    }
    if (clRange?.end) {
      clConds.push("created_at < ?");
      clBinds.push(clRange.end);
    }
    const clr = await c.env.DB.prepare(
      `SELECT * FROM notes WHERE ${clConds.join(" AND ")} ORDER BY created_at DESC LIMIT 10`
    )
      .bind(...clBinds)
      .all<NoteRow>();
    // 敏感记账笔记绝不在澄清答案中露出内容/金额
    const clRows = (clr.results ?? []).filter((n) => !n.is_sensitive);
    if (clRows.length > 0) {
      const fConds = ["user_id = ?", "deleted_at IS NULL", "category IN ('expense','income','transfer')"];
      const fBinds: unknown[] = [userId];
      if (clRange?.start) {
        fConds.push("created_at >= ?");
        fBinds.push(clRange.start);
      }
      if (clRange?.end) {
        fConds.push("created_at < ?");
        fBinds.push(clRange.end);
      }
      const fr = await c.env.DB.prepare(
        `SELECT * FROM notes WHERE ${fConds.join(" AND ")} ORDER BY created_at DESC LIMIT 2000`
      )
        .bind(...fBinds)
        .all<NoteRow>();
      const stats = financeStats(fr.results ?? []);
      const answer = buildFinanceClarifyAnswer(clarifyTerms, clRows, stats, clRange?.phrase ?? null);
      return c.json({
        answer,
        references: clRows.map((n, i) => ({ index: i + 1, note_id: n.id })),
        notes: clRows.map((n) => noteToJson(n)),
        finance_clarify: true,
      });
    }
    // 限定项没有对应记账笔记：落回普通召回，让 LLM 结合笔记原文解释
  }
  // 意图判定以原始问题为准（R113 P1）：改写只服务于召回，带历史时改写器
  // 可能给普通合计补出限定成分，绝不能因此把 exact 打成 fail-closed。
  // R129 P2-a：原问题带财务词但判定为 null（具体单项，如「午饭花了多少钱」）
  // 时，改写补出的聚合措辞不得覆盖——单项问题必须走普通召回直答该项。
  // 财务极值（R148 P1-2）：「最贵的一笔支出」走 ORDER BY amount 精确查询，
  // 按币种分组比较（不同币种金额不可直接比大小），绝不交 LLM 猜极值。
  const finExtreme = financeExtremeIntent(question) ?? (FINANCE_WORD_RE.test(question) ? null : financeExtremeIntent(recallQuestion));
  if (finExtreme) {
    const xRange = (financeExtremeIntent(question) ? parseTimeRange(question) : null) ?? timeRange;
    const xConds = ["user_id = ?", "deleted_at IS NULL", "category = ?"];
    const xBinds: unknown[] = [userId, finExtreme.direction];
    if (xRange?.start) {
      xConds.push("created_at >= ?");
      xBinds.push(xRange.start);
    }
    if (xRange?.end) {
      xConds.push("created_at < ?");
      xBinds.push(xRange.end);
    }
    const xWhere = xConds.join(" AND ");
    const order = finExtreme.kind === "max" ? "DESC" : "ASC";
    // 每币种取一条极值（窗口函数按币种分组），未识别金额的笔数单独如实说明
    const [xr, unknownRow] = await Promise.all([
      c.env.DB.prepare(
        `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY COALESCE(currency, 'CNY') ORDER BY amount ${order}, id ASC) AS rn FROM notes WHERE ${xWhere} AND amount IS NOT NULL) WHERE rn = 1 ORDER BY amount ${order}`
      )
        .bind(...xBinds)
        .all<NoteRow>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS cnt FROM notes WHERE ${xWhere} AND amount IS NULL`)
        .bind(...xBinds)
        .first<{ cnt: number }>(),
    ]);
    const xRows = xr.results ?? [];
    const answer = buildFinanceExtremeAnswer(finExtreme, xRows, unknownRow?.cnt ?? 0, xRange?.phrase ?? null);
    const xRefRows = xRows.filter((n) => !n.is_sensitive);
    return c.json({
      answer,
      references: xRefRows.map((n, i) => ({ index: i + 1, note_id: n.id })),
      notes: xRefRows.map((n) => noteToJson(n)),
      finance_extreme: true,
    });
  }
  const origFinanceIntent = financeAggIntent(question);
  const financeIntent =
    origFinanceIntent ?? (FINANCE_WORD_RE.test(question) ? null : financeAggIntent(recallQuestion));
  // 财务主题子集合计（R148 P1-2）：「咖啡一共花了多少」——主题词可干净提取时
  // 走 LIKE 圈定子集 + SQL 精确合计（此前一律 fail-closed：诚实但找回失败）
  const subsetTerms =
    financeIntent === "exact"
      ? null
      : (financeTopicTerms(question) ?? (FINANCE_WORD_RE.test(question) ? null : financeTopicTerms(recallQuestion)));
  if (subsetTerms) {
    const sRange = (financeTopicTerms(question) ? parseTimeRange(question) : null) ?? timeRange;
    const likeOrs = subsetTerms.map(() => "(content LIKE ? OR title LIKE ? OR tags LIKE ?)").join(" OR ");
    const sConds = ["user_id = ?", "deleted_at IS NULL", "category IN ('expense','income','transfer')", `(${likeOrs})`];
    const sBinds: unknown[] = [userId, ...subsetTerms.flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`])];
    if (sRange?.start) {
      sConds.push("created_at >= ?");
      sBinds.push(sRange.start);
    }
    if (sRange?.end) {
      sConds.push("created_at < ?");
      sBinds.push(sRange.end);
    }
    const sr = await c.env.DB.prepare(
      `SELECT * FROM notes WHERE ${sConds.join(" AND ")} ORDER BY created_at DESC LIMIT 2000`
    )
      .bind(...sBinds)
      .all<NoteRow>();
    const srows = sr.results ?? [];
    if (srows.length > 0) {
      const answer = buildFinanceSubsetAnswer(subsetTerms, srows, sRange?.phrase ?? null);
      const sRefRows = srows.filter((n) => !n.is_sensitive).slice(0, 10);
      return c.json({
        answer,
        references: sRefRows.map((n, i) => ({ index: i + 1, note_id: n.id })),
        notes: sRefRows.map((n) => noteToJson(n)),
        finance_subset: true,
      });
    }
    // 关键词零命中：fail-closed 说明 + 全局精确合计兜底，绝不心算估数
    const fbConds = ["user_id = ?", "deleted_at IS NULL", "category IN ('expense','income','transfer')"];
    const fbBinds: unknown[] = [userId];
    if (sRange?.start) {
      fbConds.push("created_at >= ?");
      fbBinds.push(sRange.start);
    }
    if (sRange?.end) {
      fbConds.push("created_at < ?");
      fbBinds.push(sRange.end);
    }
    const fbr = await c.env.DB.prepare(`SELECT * FROM notes WHERE ${fbConds.join(" AND ")} ORDER BY created_at DESC LIMIT 2000`)
      .bind(...fbBinds)
      .all<NoteRow>();
    const answer =
      `按关键词「${subsetTerms.join("、")}」精确匹配（标题/正文/标签）没有找到记账记录；为避免估算出错，我不做心算合计。如果你的记录用了别的说法（比如具体商品/商家名），换个关键词再问试试。\n\n` +
      buildFinanceAggAnswer(financeStats(fbr.results ?? []), sRange?.phrase ?? null);
    return c.json({ answer, references: [], notes: [], finance_subset: true, finance_fail_closed: true });
  }
  if (financeIntent) {
    // 时间范围同理优先取自原始问题；原始问题没带时间时才用改写结果
    // （代词追问「那上个月呢」靠历史补出时间是合法的）
    const fRange = (origFinanceIntent ? parseTimeRange(question) : null) ?? timeRange;
    const fConds = ["user_id = ?", "deleted_at IS NULL", "category IN ('expense','income','transfer')"];
    const fBinds: unknown[] = [userId];
    if (fRange?.start) {
      fConds.push("created_at >= ?");
      fBinds.push(fRange.start);
    }
    if (fRange?.end) {
      fConds.push("created_at < ?");
      fBinds.push(fRange.end);
    }
    const fr = await c.env.DB.prepare(
      `SELECT * FROM notes WHERE ${fConds.join(" AND ")} ORDER BY created_at DESC LIMIT 2000`
    )
      .bind(...fBinds)
      .all<NoteRow>();
    const frows = fr.results ?? [];
    const stats = financeStats(frows);
    // fail-closed (R109 P1): aggregate wording we can't scope exactly — never
    // let the LLM mental-math truncated recall (multi-currency mixing risk)
    const answer =
      financeIntent === "exact"
        ? buildFinanceAggAnswer(stats, fRange?.phrase ?? null)
        : buildFinanceFailClosedAnswer(stats, fRange?.phrase ?? null);
    // sensitive finance notes count toward totals (report口径) but never surface as cards
    const refRows = frows.filter((n) => !n.is_sensitive).slice(0, 10);
    const references = refRows.map((n, i) => ({ index: i + 1, note_id: n.id }));
    const refNotes = refRows.map((n) => noteToJson(n));
    return c.json({
      answer,
      references,
      notes: refNotes,
      finance_aggregate: financeIntent === "exact",
      ...(financeIntent === "fail_closed" ? { finance_fail_closed: true } : {}),
    });
  }
  // 极值/排序类统计（R126 P1-3）：「最早/最新/最长一条笔记」是一条
  // min/max/order-by SQL 就能精确回答的，绝不交 LLM 对 top-k 召回猜答
  const extremeKind = extremeQueryIntent(question) ?? extremeQueryIntent(recallQuestion);
  const answerExtreme = async (kind: NonNullable<ReturnType<typeof extremeQueryIntent>>) => {
    const order =
      kind === "earliest"
        ? "created_at ASC, id ASC"
        : kind === "latest"
          ? "created_at DESC, id DESC"
          : "LENGTH(content) DESC, id ASC";
    const row = await c.env.DB.prepare(
      `SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL ORDER BY ${order} LIMIT 1`
    )
      .bind(userId)
      .first<NoteRow>();
    const answer = buildExtremeAnswer(kind, row ?? null);
    const refs = row && !row.is_sensitive ? [{ index: 1, note_id: row.id }] : [];
    const notes = row && !row.is_sensitive ? [noteToJson(row)] : [];
    return c.json({ answer, references: refs, notes, extreme_aggregate: true });
  };
  if (extremeKind) return answerExtreme(extremeKind);
  // 计数类问题同理走 SQL COUNT 精确统计（R124 P1-2：「记了多少条」曾被 LLM
  // 从 top-k 召回窗口猜成 16，实为 210）；意图/时间同样以原始问题优先。
  // R126：分类/敏感/日均限定也是可 SQL 化的精确计数，不再落 fail-closed
  // 主题关键词计数（R148 P1-2）：「记录过几次房租」走 LIKE 精确计数，
  // 答案如实标注按关键词匹配口径（R147 实测：LLM 从 top-k 猜 4 次，实为 6）
  const topicCnt = topicCountIntent(question) ?? topicCountIntent(recallQuestion);
  if (topicCnt) {
    const tcRange = (topicCountIntent(question) ? parseTimeRange(question) : null) ?? timeRange;
    const tcConds = ["user_id = ?", "deleted_at IS NULL", "(content LIKE ? OR title LIKE ? OR tags LIKE ?)"];
    const tcBinds: unknown[] = [userId, `%${topicCnt}%`, `%${topicCnt}%`, `%${topicCnt}%`];
    if (tcRange?.start) {
      tcConds.push("created_at >= ?");
      tcBinds.push(tcRange.start);
    }
    if (tcRange?.end) {
      tcConds.push("created_at < ?");
      tcBinds.push(tcRange.end);
    }
    const tcWhere = tcConds.join(" AND ");
    const [tcRow, tcRows] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(is_sensitive), 0) AS sens FROM notes WHERE ${tcWhere}`)
        .bind(...tcBinds)
        .first<{ cnt: number; sens: number }>(),
      c.env.DB.prepare(`SELECT * FROM notes WHERE ${tcWhere} ORDER BY created_at DESC LIMIT 10`)
        .bind(...tcBinds)
        .all<NoteRow>(),
    ]);
    const answer = buildTopicCountAnswer(topicCnt, tcRow?.cnt ?? 0, tcRow?.sens ?? 0, tcRange?.phrase ?? null);
    const tcRefRows = (tcRows.results ?? []).filter((n) => !n.is_sensitive);
    return c.json({
      answer,
      references: tcRefRows.map((n, i) => ({ index: i + 1, note_id: n.id })),
      notes: tcRefRows.map((n) => noteToJson(n)),
      count_aggregate: true,
      topic_count: true,
    });
  }
  const origCountQuery = countQueryIntent(question);
  const countQuery = origCountQuery ?? countQueryIntent(recallQuestion);
  if (countQuery) {
    const cRange = (origCountQuery ? parseTimeRange(question) : null) ?? timeRange;
    const cConds = ["user_id = ?", "deleted_at IS NULL"];
    const cBinds: unknown[] = [userId];
    if (cRange?.start) {
      cConds.push("created_at >= ?");
      cBinds.push(cRange.start);
    }
    if (cRange?.end) {
      cConds.push("created_at < ?");
      cBinds.push(cRange.end);
    }
    // 分类/敏感限定计数：单条 WHERE 精确回答（R125 Q9/Q10/Q12/Q15）
    if (countQuery.intent === "exact" && (countQuery.category || countQuery.sensitiveOnly)) {
      const scoped = [...cConds, countQuery.category ? "category = ?" : "is_sensitive = 1"];
      const scopedBinds = countQuery.category ? [...cBinds, countQuery.category] : cBinds;
      const r = await c.env.DB.prepare(`SELECT COUNT(*) AS cnt FROM notes WHERE ${scoped.join(" AND ")}`)
        .bind(...scopedBinds)
        .first<{ cnt: number }>();
      const label = countQuery.category
        ? (COUNT_SCOPE_LABELS[countQuery.category] ?? countQuery.category)
        : "加密的敏感笔记";
      const answer = buildScopedCountAnswer(r?.cnt ?? 0, label, cRange?.phrase ?? null);
      return c.json({ answer, references: [], notes: [], count_aggregate: true });
    }
    // 日均计数（R125 Q4）：总数 ÷ 首条笔记至今天数，纯 SQL 可得
    if (countQuery.intent === "exact" && countQuery.avgPerDay) {
      const r = await c.env.DB.prepare(
        "SELECT COUNT(*) AS cnt, MIN(created_at) AS first FROM notes WHERE user_id = ? AND deleted_at IS NULL"
      )
        .bind(userId)
        .first<{ cnt: number; first: string | null }>();
      const answer = buildAvgPerDayAnswer(r?.cnt ?? 0, r?.first ?? null);
      return c.json({ answer, references: [], notes: [], count_aggregate: true });
    }
    const where = cConds.join(" AND ");
    const [totalRow, catRows] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS cnt, SUM(is_sensitive) AS sens FROM notes WHERE ${where}`)
        .bind(...cBinds)
        .first<{ cnt: number; sens: number | null }>(),
      c.env.DB.prepare(`SELECT category, COUNT(*) AS cnt FROM notes WHERE ${where} GROUP BY category ORDER BY cnt DESC`)
        .bind(...cBinds)
        .all<{ category: string | null; cnt: number }>(),
    ]);
    const total = totalRow?.cnt ?? 0;
    const sens = totalRow?.sens ?? 0;
    const byCat = catRows.results ?? [];
    const answer =
      countQuery.intent === "exact"
        ? buildCountAnswer(total, byCat, sens, cRange?.phrase ?? null)
        : buildCountFailClosedAnswer(total, byCat, sens, cRange?.phrase ?? null);
    return c.json({ answer, references: [], notes: [], count_aggregate: countQuery.intent === "exact", ...(countQuery.intent === "fail_closed" ? { count_fail_closed: true } : {}) });
  }
  // 主题枚举（R130 P1-1）：「我看过什么书/存过哪些菜谱」先走关键词/标签
  // LIKE 全量筛选（与计数/财务同一精确查询家族），语义 top-k 只在零命中时
  // 兜底（R129 R8：宽泛主题词的语义召回被高频主题压过，答非所问）。
  let enumTopic = topicEnumIntent(question) ?? topicEnumIntent(recallQuestion);
  let enumList = enumListIntent(question) || enumListIntent(recallQuestion);
  // 主题限定优先于时间窗全量枚举：「记过哪些关于 X 的想法」不被全量枚举劫持，
  // 主题关键词零命中时落回普通召回（语义兜底）而非列出全部笔记
  if (enumTopic) enumList = false;
  // 统一意图分类（R132 P1，落实 R131 D-1）：规则全部未命中时才问 LLM 一次，
  // 只接受参数可严格校验的枚举/极值意图（主题词须出现在原问题中）；
  // 校验不过或 AI 不可用则回落普通召回，既有规则路由行为不变。
  if (!enumTopic && !enumList) {
    const llmIntent = await classifyAskIntent(c.env, question);
    if (llmIntent?.intent === "topic_enum" && llmIntent.topic) enumTopic = llmIntent.topic;
    else if (llmIntent?.intent === "enum_list") enumList = true;
    else if (llmIntent?.intent === "extreme" && llmIntent.extreme) return answerExtreme(llmIntent.extreme);
  }
  if (enumTopic) {
    const like = `%${enumTopic}%`;
    const tConds = ["user_id = ?", "deleted_at IS NULL", "(content LIKE ? OR title LIKE ? OR tags LIKE ? OR url_title LIKE ?)"];
    const tBinds: unknown[] = [userId, like, like, like, like];
    if (timeRange?.start) {
      tConds.push("created_at >= ?");
      tBinds.push(timeRange.start);
    }
    if (timeRange?.end) {
      tConds.push("created_at < ?");
      tBinds.push(timeRange.end);
    }
    const tWhere = tConds.join(" AND ");
    const TOPIC_ENUM_MAX = 50;
    const [tTotalRow, tListRows] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS cnt, SUM(is_sensitive) AS sens FROM notes WHERE ${tWhere}`)
        .bind(...tBinds)
        .first<{ cnt: number; sens: number | null }>(),
      c.env.DB.prepare(`SELECT * FROM notes WHERE ${tWhere} ORDER BY created_at DESC LIMIT ${TOPIC_ENUM_MAX}`)
        .bind(...tBinds)
        .all<NoteRow>(),
    ]);
    const tTotal = tTotalRow?.cnt ?? 0;
    if (tTotal > 0) {
      const tSens = tTotalRow?.sens ?? 0;
      const tRows = tListRows.results ?? [];
      const tLines = enumNoteLines(tRows);
      let answer = `${timeRange?.phrase ?? ""}和「${enumTopic}」相关的记录共 ${tTotal} 条`;
      if (tSens > 0) answer += `（含 ${tSens} 条加密的敏感笔记）`;
      answer += `：\n\n${tLines.join("\n")}`;
      if (tTotal > tRows.length) answer += `\n\n……其余 ${tTotal - tRows.length} 条可在时间流搜索「${enumTopic}」查看。`;
      answer += `\n\n以上为按关键词「${enumTopic}」在全部笔记中精确筛选的结果（不含已删除笔记）；相关但没写到这个词的笔记可换个说法再问。`;
      const tRefRows = tRows.filter((n) => !n.is_sensitive).slice(0, 10);
      return c.json({
        answer,
        references: tRefRows.map((n, i) => ({ index: i + 1, note_id: n.id })),
        notes: tRefRows.map((n) => noteToJson(n)),
        enum_aggregate: true,
        enum_topic: enumTopic,
      });
    }
    // 关键词零命中：落回普通召回（语义仍可能兜底），不 dead-end
  }
  // 时间窗/全量枚举（「上周都记了什么」「列出我所有的笔记」）：SQL 全量列举 +
  // 精确总数，不走 top-k 召回（R123：枚举不全且无总数口径）；无时间限定时
  // 枚举全部笔记（R132：同义问法实测「列出所有笔记」无精确路由可走）
  if (enumList) {
    const eConds = ["user_id = ?", "deleted_at IS NULL"];
    const eBinds: unknown[] = [userId];
    if (timeRange?.start) {
      eConds.push("created_at >= ?");
      eBinds.push(timeRange.start);
    }
    if (timeRange?.end) {
      eConds.push("created_at < ?");
      eBinds.push(timeRange.end);
    }
    const where = eConds.join(" AND ");
    const ENUM_LIST_MAX = 50;
    const [totalRow, listRows] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) AS cnt, SUM(is_sensitive) AS sens FROM notes WHERE ${where}`)
        .bind(...eBinds)
        .first<{ cnt: number; sens: number | null }>(),
      c.env.DB.prepare(`SELECT * FROM notes WHERE ${where} ORDER BY created_at DESC LIMIT ${ENUM_LIST_MAX + 1}`)
        .bind(...eBinds)
        .all<NoteRow>(),
    ]);
    const total = totalRow?.cnt ?? 0;
    const sens = totalRow?.sens ?? 0;
    const rows = (listRows.results ?? []).slice(0, ENUM_LIST_MAX);
    const phrase = timeRange?.start ? timeRange.phrase : "";
    if (total === 0) {
      return c.json({ answer: `${phrase}你没有记录任何笔记。`, references: [], notes: [], enum_aggregate: true });
    }
    const lines = enumNoteLines(rows);
    let answer = `${phrase}你一共记了 ${total} 条笔记`;
    if (sens > 0) answer += `（含 ${sens} 条加密的敏感笔记）`;
    answer += `：\n\n${lines.join("\n")}`;
    if (total > rows.length) answer += `\n\n……其余 ${total - rows.length} 条可在时间流按时间筛选查看。`;
    answer += "\n\n以上为数据库精确列举（不含已删除笔记）。";
    const refRows = rows.filter((n) => !n.is_sensitive).slice(0, 10);
    return c.json({
      answer,
      references: refRows.map((n, i) => ({ index: i + 1, note_id: n.id })),
      notes: refRows.map((n) => noteToJson(n)),
      enum_aggregate: true,
    });
  }
  let terms = extractAskTerms(recallQuestion, history);
  // unsegmented CJK clauses never LIKE-match: extract real keywords via LLM,
  // keeping any short naive terms; failures keep the naive terms untouched
  if (needsCjkKeywordExtraction(terms) || needsBilingualKeywordExtraction(recallQuestion)) {
    const kw = await extractAskKeywords(c.env, recallQuestion);
    if (kw.length > 0) {
      terms = [...kw, ...terms.filter((t) => !(CJK_RE.test(t) && t.length >= 8))]
        .filter((t, i, a) => a.indexOf(t) === i)
        .slice(0, 8);
    }
  }
  // 带历史时改写器可能丢掉原问题里能命中目标笔记的关键词（R115 P2 召回
  // 抖动）：原始问题的关键词并入召回词集，改写只能增补、不能搞丢。
  if (history.length > 0 && recallQuestion !== question) {
    for (const t of extractAskTerms(question, [])) {
      if (!terms.includes(t) && terms.length < 10) terms.push(t);
    }
  }
  // sensitive (encrypted) notes never enter the ask context — not even their titles
  const conds: string[] = ["user_id = ?", "is_sensitive = 0"];
  const binds: unknown[] = [userId];
  if (terms.length > 0) {
    const ors = terms.map(() => "(content LIKE ? OR title LIKE ? OR tags LIKE ? OR url_title LIKE ?)");
    conds.push(`(${ors.join(" OR ")})`);
    for (const t of terms) {
      const like = `%${t}%`;
      binds.push(like, like, like, like);
    }
  }
  if (timeRange?.start) {
    conds.push("created_at >= ?");
    binds.push(timeRange.start);
  }
  if (timeRange?.end) {
    conds.push("created_at < ?");
    binds.push(timeRange.end);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM notes WHERE ${conds.join(" AND ")} AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 20`
  )
    .bind(...binds)
    .all<NoteRow>();
  let notes = results ?? [];

  // 元属性召回（R134 D-3，P2-1）：问题按输入形态提问（语音/图片/文件）时，
  // 把该 raw_type 的最近笔记并入候选——形态词不在转写正文里，关键词与语义都够不着
  const mediaType = mediaTypeIntent(question) ?? mediaTypeIntent(recallQuestion);
  if (mediaType) {
    const mConds = ["user_id = ?", "is_sensitive = 0", "deleted_at IS NULL", "raw_type = ?"];
    const mBinds: unknown[] = [userId, mediaType];
    if (timeRange?.start) {
      mConds.push("created_at >= ?");
      mBinds.push(timeRange.start);
    }
    if (timeRange?.end) {
      mConds.push("created_at < ?");
      mBinds.push(timeRange.end);
    }
    const mr = await c.env.DB.prepare(
      `SELECT * FROM notes WHERE ${mConds.join(" AND ")} ORDER BY created_at DESC LIMIT 10`
    )
      .bind(...mBinds)
      .all<NoteRow>();
    const haveIds = new Set(notes.map((n) => n.id));
    const mediaExtras = (mr.results ?? []).filter((n) => !haveIds.has(n.id));
    // 形态命中排在前面，与关键词命中共享 20 条上限
    if (mediaExtras.length > 0) notes = [...mediaExtras, ...notes].slice(0, 20);
  }

  // hybrid recall: add semantic hits (same query-rewritten question) that the
  // keyword LIKE recall missed; failures silently degrade to keyword-only
  const semHits = await semanticRecall(c.env, userId, recallQuestion, 10);
  const semScore = new Map(semHits.map((h) => [h.note_id, h.score]));
  const have = new Set(notes.map((n) => n.id));
  const extraIds = semHits.filter((h) => !have.has(h.note_id)).map((h) => h.note_id);
  // semantic hits outside an explicit time window are kept aside as suggestions
  let outOfRange: NoteRow[] = [];
  if (extraIds.length > 0) {
    const ph = extraIds.map(() => "?").join(",");
    const r = await c.env.DB.prepare(
      `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL AND id IN (${ph})`
    )
      .bind(userId, ...extraIds)
      .all<NoteRow>();
    const byId = new Map((r.results ?? []).map((n) => [n.id, n]));
    let extras = extraIds.map((id) => byId.get(id)).filter((n): n is NoteRow => !!n);
    if (timeRange) {
      outOfRange = extras.filter((n) => !inTimeRange(n.created_at, timeRange));
      extras = extras.filter((n) => inTimeRange(n.created_at, timeRange));
    }
    // semantic hits go first in score order so they survive the 20-note cap
    notes = [...extras, ...notes].slice(0, 20);
  }
  // time window emptied recall entirely: relax it (the model sees dates and
  // can say the hits are outside the asked window) instead of a dead end
  if (notes.length === 0 && outOfRange.length > 0) {
    notes = outOfRange.slice(0, 20);
    outOfRange = [];
  }
  // GraphRAG: expand recalled notes 1 hop along the knowledge graph so strongly
  // related fragments (shared entities/relations) join the context
  const graphNoteIds = new Set<string>();
  let graphTriples: string[] = [];
  if (useGraph && notes.length > 0) {
    // relation-flavored questions (evolution / why / follow-up / provenance)
    // lean hardest on the graph: widen the expansion budget for them
    const relationQ = /关系|关联|变化|演化|脉络|为什么|依据|后来|进展|着落|转折|一步步|怎么变/.test(recallQuestion);
    const expansion = await graphExpand(c.env, userId, notes.map((n) => n.id), relationQ ? 8 : 5, recallQuestion);
    graphTriples = expansion.triples;
    const missing = expansion.note_ids.filter((nid) => !notes.some((n) => n.id === nid));
    if (missing.length > 0) {
      const ph = missing.map(() => "?").join(",");
      const r = await c.env.DB.prepare(
        `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL AND id IN (${ph})`
      )
        .bind(userId, ...missing)
        .all<NoteRow>();
      // graph notes get reserved slots beyond the base 20-note cap (up to 25
      // total) — otherwise a full keyword recall silently drops every one
      for (const n of r.results ?? []) {
        graphNoteIds.add(n.id);
        notes.push(n);
      }
      notes = notes.slice(0, 25);
    }
  }
  // 多跳二次检索（R112 P1-1）：因果/对应/后续类问题的第二跳笔记往往与问题
  // 本身无词面/语义重叠（如「白板目标后来有着落吗」需要落地那一条）：用
  // 首轮命中的 top 片段拼接问题再做一次语义召回，只对命中多跳措辞的问题
  // 触发（单跳问题零额外延迟），且只增补≤6 条、总上下文封顶 30 条。
  const multiHopIds = new Set<string>();
  if (notes.length > 0 && !timeRange && MULTI_HOP_RE.test(recallQuestion)) {
    try {
      const seeds = notes
        .slice(0, 3)
        .map((n) => `${n.title ?? ""} ${n.content.slice(0, 160)}`.trim())
        .join("\n");
      const hopHits = await semanticRecall(c.env, userId, `${recallQuestion}\n${seeds}`, 8);
      // notes already in context that the enriched query now scores well get
      // their weak-extra stigma lifted (they'd otherwise be stripped from
      // citations by the ASK_CITATION_MIN_SCORE reconcile below)
      for (const h of hopHits) {
        if (h.score >= ASK_CITATION_MIN_SCORE && notes.some((n) => n.id === h.note_id)) {
          multiHopIds.add(h.note_id);
          semScore.set(h.note_id, Math.max(semScore.get(h.note_id) ?? 0, h.score));
        }
      }
      const missing = hopHits.filter((h) => !notes.some((n) => n.id === h.note_id)).slice(0, 6);
      if (missing.length > 0) {
        const ph = missing.map(() => "?").join(",");
        const r = await c.env.DB.prepare(
          `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL AND id IN (${ph})`
        )
          .bind(userId, ...missing.map((h) => h.note_id))
          .all<NoteRow>();
        const hopById = new Map((r.results ?? []).map((n) => [n.id, n]));
        const hopNotes: NoteRow[] = [];
        for (const h of missing) {
          const n = hopById.get(h.note_id);
          if (!n) continue;
          multiHopIds.add(n.id);
          semScore.set(n.id, Math.max(semScore.get(n.id) ?? 0, h.score));
          hopNotes.push(n);
        }
        // slot second-hop notes right behind the seed hits so they land in
        // the part of the context the model actually cites from
        notes.splice(Math.min(3, notes.length), 0, ...hopNotes);
        notes = notes.slice(0, 30);
      }
    } catch (err) {
      console.error("ask: multi-hop second recall failed", err);
    }
  }
  if (notes.length === 0) {
    // nothing recalled at all: answer "没找到" honestly (never bluff over the
    // recent-20) and suggest the nearest notes below the semantic threshold
    const near = await semanticRecall(c.env, userId, recallQuestion, 3, ASK_SUGGESTION_MIN_SCORE);
    let suggestions: NoteRow[] = [];
    if (near.length > 0) {
      const ph = near.map(() => "?").join(",");
      const r = await c.env.DB.prepare(
        `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL AND id IN (${ph})`
      )
        .bind(userId, ...near.map((h) => h.note_id))
        .all<NoteRow>();
      const byId = new Map((r.results ?? []).map((n) => [n.id, n]));
      suggestions = near.map((h) => byId.get(h.note_id)).filter((n): n is NoteRow => !!n);
    }
    // 宁缺毋滥（R118 P2）：零召回时只把真命中主题词的笔记当建议，
    // 避免把仅语义擦边的无关笔记称作“相近的记录”
    const zeroTopics = askTopicTerms(terms);
    if (zeroTopics.length > 0) {
      const topicHits = suggestions.filter((n) => noteHitsTopic(n, zeroTopics));
      suggestions = topicHits.length > 0 ? topicHits : [];
    }
    const { answer, references } = buildNoAnswerResponse(suggestions);
    const sensitiveHits = await countSensitiveHits(c.env, userId, terms);
    const sugById = new Map(suggestions.map((n) => [n.id, n]));
    const refNotes = await Promise.all(
      references.map((r) => noteToJsonDecrypted(c.env, sugById.get(r.note_id)!))
    );
    return c.json({ answer: answer + sensitiveHintLine(sensitiveHits, terms), references, notes: refNotes, no_answer: true });
  }

  const noteIds = notes.map((n) => n.id);
  const context = notes
    .map((n, i) => {
      const tags = (JSON.parse(n.tags || "[]") as string[]).join(",");
      const extras = [
        n.todo_due ? `截止:${normalizeStoredTodoDue(n.todo_due) ?? n.todo_due}` : "",
        n.todo_done ? "已完成" : "",
        tags ? `标签:${tags}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      const graphTag = graphNoteIds.has(n.id) ? ", 图谱关联" : multiHopIds.has(n.id) ? ", 二跳关联" : "";
      return `[${i + 1}] (id=${n.id}, ${n.created_at}, ${n.category ?? ""}${extras ? `, ${extras}` : ""}${graphTag}) ${n.title ?? ""}\n${n.content.slice(0, 500)}`;
    })
    .join("\n\n");
  const answer = await chatComplete(c.env, {
    temperature: 0.3,
    max_tokens: 800,
    timeout_ms: 40_000,
    messages: [
      {
        role: "system",
        content:
          "你是「碎念」个人笔记问答助手。根据下面用户的笔记片段回答问题，引用时用 [序号] 标注。每个片段括号里的日期是记录时间——问题限定了时间范围（如上个月/最近一周）时，只依据落在该范围内的片段作答；范围外的可提一句但要说明时间对不上。标注「图谱关联」的片段是沿知识图谱找到的强关联碎片，标注「二跳关联」的片段是顺着首轮命中笔记二次检索到的后续/对应碎片，回答因果、对应、后续进展类问题时请优先结合它们并标注引用，「实体关系」列出了笔记间的关系脉络——回答涉及跨碎片关联时请说明依据（如某想法的前提/支撑来自哪条）。回答演化/决策类问题（怎么变化的/做过哪些决定）时，按时间顺序逐步列出，从起点（如立项/最初想法）到最新状态，每一步都要标注对应片段的 [序号]。可结合之前的对话上下文理解代词与省略。问题问到具体数字（价格/报价/金额/日期/电话等）时，必须逐字引用片段中的原始数字，不要四舍五入或省略单位；只要某个片段包含与问题主题对应的数字（如问「土鸡蛋报价」而片段写着「土鸡蛋报价：每斤 8.5 元」），就直接给出该数字作答，绝不要以「没找到」开头再自我矛盾地补充。只有当所有片段都与问题无关时，才直接说没找到，绝不要编造或强行凑答案；笔记里没提到的事实不要自行断定（如「不支持/没有」），应说「笔记里没提到」；回答不要以「不是」等否定词开头，除非确实在纠正问题里的错误前提。只输出结论本身，不要输出检索/推理过程或对片段相关性的逐条评论（如「[1]、[2] 中没有直接相关的信息，但根据…」这类过程碎碎念）；汇总计算时也不要解释为什么排除某一项（如「68 元（买书，不属于吃的，忽略）」这类筛选过程），算式里只列入选项。涉及金额汇总时，不同币种（如 CNY 与 USD）绝不能直接相加，必须分币种分别合计并注明币种；分类为 transfer（资金往来：内转/提现/借入）的金额不是支出也不是收入，不要计入收支合计。回答用中文，简洁。",
      },
      ...history,
      {
        role: "user",
        content: `笔记片段：\n${context || "（无相关笔记）"}${
          graphTriples.length > 0 ? `\n\n实体关系：\n${graphTriples.join("\n")}` : ""
        }${timeRange ? `\n\n（问题的时间范围：${timeRange.phrase}）` : ""}\n\n问题：${question}${
          recallQuestion !== question ? `\n（即：${recallQuestion}）` : ""
        }`,
      },
    ],
  });
  // semantic-only hits (never keyword-matched) below the citation threshold
  const weakIds = new Set(extraIds.filter((id) => (semScore.get(id) ?? 0) < ASK_CITATION_MIN_SCORE));
  // 检索命中却误拒答（R113 P1）：强命中（关键词命中或语义分达标）存在时，
  // 拒答很可能是历史话题干扰下的误判：去掉对话历史、同一上下文重问一次，
  // 仍拒答才诚实返回「没找到」。
  let answer2 = answer;
  if (answer2 && isRefusalAnswer(answer2) && notes.some((n) => !weakIds.has(n.id))) {
    const retry = await chatComplete(c.env, {
      temperature: 0,
      max_tokens: 800,
      timeout_ms: 40_000,
      messages: [
        {
          role: "system",
          content:
            "你是「碎念」个人笔记问答助手。下面的笔记片段是检索系统针对这个问题命中的结果，其中很可能包含答案。请逐条仔细阅读每个片段后回答问题，引用时用 [序号] 标注。问题问到具体数字时逐字引用原始数字。只有当所有片段确实都与问题无关时，才说没找到。只输出结论本身，回答用中文，简洁。",
        },
        {
          role: "user",
          content: `笔记片段：\n${context}\n\n问题：${recallQuestion}`,
        },
      ],
    });
    if (retry && !isRefusalAnswer(retry)) {
      console.log("ask: refusal retry recovered an answer");
      answer2 = retry;
    }
  }
  // the model itself concluded "没找到" over recalled topic notes: honest
  // wording is 「笔记里没提到」, not 「没找到相关笔记」 (R115 P2 拒答口径)；
  // suggestions prefer strong semantic hits, falling back to the top recall
  if (answer2 && isRefusalAnswer(answer2)) {
    // 主题笔记优先（R118 P2）：语义分上“花钱类”笔记会压过真正的主题
    // 笔记（理发），建议列表先排命中主题词的，再按语义分排
    const topics = askTopicTerms(terms);
    const ranked = [...notes].sort((a, b) => {
      const ta = noteHitsTopic(a, topics) ? 1 : 0;
      const tb = noteHitsTopic(b, topics) ? 1 : 0;
      if (ta !== tb) return tb - ta;
      return (semScore.get(b.id) ?? 0) - (semScore.get(a.id) ?? 0);
    });
    let suggestions = ranked
      .filter((n) => noteHitsTopic(n, topics) || (semScore.get(n.id) ?? 0) >= ASK_SUGGESTION_MIN_SCORE)
      .slice(0, 3);
    if (suggestions.length === 0) suggestions = notes.slice(0, 3);
    // 凭据类问法（R147 P2-1）：只留真命中主题词的建议，不拿无关笔记
    // 充数；否则「银行卡密码」这类问题会引三条无关笔记误导用户
    const credentialQ = CREDENTIAL_Q_RE.test(question);
    if (credentialQ) suggestions = suggestions.filter((n) => noteHitsTopic(n, topics));
    // only claim 「找到了相关的笔记」 when recall had strong hits AND at least
    // one of them actually contains a topic word (R117 零召回误称相关)
    const mode =
      notes.some((n) => !weakIds.has(n.id)) && (topics.length === 0 || notes.some((n) => noteHitsTopic(n, topics)))
        ? "not_in_notes"
        : "no_recall";
    const { answer: noAnswer, references } = buildNoAnswerResponse(suggestions, mode);
    const sensitiveHits = await countSensitiveHits(c.env, userId, terms);
    // 凭据类问题关键词没匹配到敏感元数据时，只要用户确有敏感笔记，
    // 也给同一套敏感指引（不报计数，避免误导）
    let hint = sensitiveHintLine(sensitiveHits, terms);
    if (!hint && credentialQ) {
      const anySensitive = await c.env.DB.prepare(
        "SELECT 1 FROM notes WHERE user_id = ? AND is_sensitive = 1 AND deleted_at IS NULL LIMIT 1"
      )
        .bind(userId)
        .first();
      if (anySensitive) hint = credentialHintLine();
    }
    const sugById = new Map(suggestions.map((n) => [n.id, n]));
    const refNotes = await Promise.all(
      references.map((r) => noteToJsonDecrypted(c.env, sugById.get(r.note_id)!))
    );
    return c.json({ answer: noAnswer + hint, references, notes: refNotes, no_answer: true });
  }
  // weak semantic-only hits stay in the context but never surface as
  // citations; the answer text and the references array are rewritten
  // together so no [n] marker dangles
  const { answer: finalAnswer, references } = reconcileAskCitations(answer2 ?? "", noteIds, weakIds);
  const byId = new Map(notes.map((n) => [n.id, n]));
  const refNotes = await Promise.all(
    references.map((r) => noteToJsonDecrypted(c.env, byId.get(r.note_id)!))
  );
  if (!answer2) {
    return c.json({ answer: "（AI 暂不可用）已找到相关记录，见 references。", references, notes: refNotes });
  }
  return c.json({ answer: finalAnswer, references, notes: refNotes });
});

// ---- GET /api/threads ----
// last_note_at = newest fragment's created_at; the list sorts by it so that
// "recently written-into" threads rank first (updated_at is bumped by the
// daily summary refresh for every thread and doesn't reflect real activity).
app.get("/api/threads", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, (SELECT MAX(n.created_at) FROM notes n WHERE n.thread_id = t.id AND n.deleted_at IS NULL) AS last_note_at,
            (SELECT MIN(n.created_at) FROM notes n WHERE n.thread_id = t.id AND n.deleted_at IS NULL) AS first_note_at,
            (SELECT COUNT(*) FROM notes n WHERE n.thread_id = t.id AND n.deleted_at IS NULL AND n.created_at >= datetime('now', '-7 days')) AS week_new_count
       FROM threads t WHERE t.user_id = ? AND t.note_count > 0
      ORDER BY last_note_at DESC LIMIT 100`
  )
    .bind(c.get("userId"))
    .all<ThreadRow>();
  return c.json({ threads: results ?? [] });
});

/** Public job shape for the rebuild progress endpoints. */
function threadJobJson(job: {
  id: string;
  status: string;
  phase: string;
  total: number;
  processed: number;
  threads: number | null;
  state: string | null;
  error: string | null;
}) {
  let summarized = 0;
  let summarizeTotal = 0;
  try {
    const s = job.state ? (JSON.parse(job.state) as { summarized?: number; summarizeTotal?: number }) : null;
    summarized = s?.summarized ?? 0;
    summarizeTotal = s?.summarizeTotal ?? 0;
  } catch {
    /* older jobs have no summarize counters */
  }
  return {
    job_id: job.id,
    status: job.status,
    phase: job.phase,
    total: job.total,
    processed: job.processed,
    summarized,
    summarize_total: summarizeTotal,
    threads: job.threads,
    error: job.error,
  };
}

// ---- POST /api/threads/rebuild ----
// Async: enqueues a full-history rebuild job and returns its id immediately.
// The first slice runs in this request's waitUntil; the 10-minute cron picks
// up whatever is left, so 20-minute rebuilds survive the request lifetime.
app.post("/api/threads/rebuild", async (c) => {
  const userId = c.get("userId");
  // 全量重建是重 AI 负载（每条笔记都可能调嵌入/图谱）：泄露 token 不能无限触发
  if (!(await checkRateLimit(c.env.DB, "thread_rebuild", [userId], THREAD_REBUILD_RATE_LIMIT_MAX))) {
    return c.json({ error: "重建太频繁了，请稍等一分钟再试", retryable: true }, 429);
  }
  // mode=similarity re-clusters with the pre-graph embedding-only algorithm (A/B comparison & debugging)
  const body = await c.req.json<{ mode?: string }>().catch(() => null);
  const existing = await getActiveThreadJob(c.env, userId);
  if (existing) return c.json(threadJobJson(existing), 200);
  const job = await createRebuildJob(c.env, userId, { useGraph: body?.mode !== "similarity" });
  c.executionCtx.waitUntil(runRebuildJobSlice(c.env, job.id, REBUILD_SLICE_BUDGET_MS));
  return c.json(threadJobJson(job), 202);
});

/** A running job whose slice died (stale heartbeat) gets resumed opportunistically on poll. */
function kickStaleJob(c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } }, job: { id: string; status: string; updated_at: string }) {
  if (job.status !== "running" && job.status !== "queued") return;
  // a slice lives at most ~30s (HTTP waitUntil window), so a 45s-old
  // heartbeat means the last slice is dead and a new one can take over
  const ageMs = Date.now() - new Date(job.updated_at.replace(" ", "T") + "Z").getTime();
  if (job.status === "queued" || ageMs > 45_000) {
    c.executionCtx.waitUntil(runRebuildJobSlice(c.env, job.id, REBUILD_SLICE_BUDGET_MS));
  }
}

// ---- GET /api/threads/rebuild/latest ----
// The user's most recent rebuild job (active first), so a page refresh can
// restore the progress banner. 404 when the user never ran a rebuild.
app.get("/api/threads/rebuild/latest", async (c) => {
  const userId = c.get("userId");
  const job =
    (await getActiveThreadJob(c.env, userId)) ??
    (await c.env.DB.prepare("SELECT * FROM thread_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(userId)
      .first<ThreadJobRow>());
  if (!job) return c.json({ error: "not found" }, 404);
  kickStaleJob(c, job);
  return c.json(threadJobJson(job));
});

// ---- GET /api/threads/rebuild/:jobId ----
app.get("/api/threads/rebuild/:jobId", async (c) => {
  const job = await getThreadJob(c.env, c.get("userId"), c.req.param("jobId"));
  if (!job) return c.json({ error: "not found" }, 404);
  kickStaleJob(c, job);
  return c.json(threadJobJson(job));
});

// ---- GET /api/threads/:id ----
app.get("/api/threads/:id", async (c) => {
  const userId = c.get("userId");
  const thread = await c.env.DB.prepare("SELECT * FROM threads WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), userId)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM notes WHERE thread_id = ? AND user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 200"
  )
    .bind(thread.id, userId)
    .all<NoteRow>();
  const notes = await Promise.all((results ?? []).map((n) => noteToJsonDecrypted(c.env, n)));
  const graph = await getThreadGraph(c.env, userId, (results ?? []).map((n) => n.id));
  return c.json({ thread, notes, graph });
});

// ---- GET /api/review/today ----
// Today's 被动回顾 items (那年今日 / 上月今日 / 久未回看), generated on demand
// when the daily cron hasn't produced them yet.
app.get("/api/review/today", async (c) => {
  const { date, items } = await getTodayReview(c.env, c.get("userId"));
  return c.json({
    date,
    items: items.map((it) => ({
      id: it.id,
      kind: it.kind,
      kind_label: it.kind_label,
      comment: it.comment,
      note: noteToJson(it.note),
    })),
  });
});

// ---- GET /api/preferences ----
// 推送偏好（每日回顾 / 待办提醒），无记录时默认全开
app.get("/api/preferences", async (c) => {
  const row = await c.env.DB.prepare("SELECT daily_review_push, todo_reminder_push, tz FROM user_preferences WHERE user_id = ?")
    .bind(c.get("userId"))
    .first<{ daily_review_push: number; todo_reminder_push: number; tz: string | null }>();
  return c.json({
    daily_review_push: row ? row.daily_review_push === 1 : true,
    todo_reminder_push: row ? row.todo_reminder_push === 1 : true,
    tz: row?.tz ?? null,
  });
});

// ---- PATCH /api/preferences ----
app.patch("/api/preferences", async (c) => {
  const body = await c.req
    .json<{ daily_review_push?: boolean; todo_reminder_push?: boolean; tz?: string }>()
    .catch(() => null);
  const hasTz = typeof body?.tz === "string";
  if (!body || (typeof body.daily_review_push !== "boolean" && typeof body.todo_reminder_push !== "boolean" && !hasTz))
    return c.json({ error: "nothing to update" }, 400);
  if (hasTz && !isValidTimezone(body.tz as string)) return c.json({ error: "invalid tz" }, 400);
  const userId = c.get("userId");
  const cur = await c.env.DB.prepare("SELECT daily_review_push, todo_reminder_push, tz FROM user_preferences WHERE user_id = ?")
    .bind(userId)
    .first<{ daily_review_push: number; todo_reminder_push: number; tz: string | null }>();
  const next = {
    daily_review_push: body.daily_review_push ?? (cur ? cur.daily_review_push === 1 : true),
    todo_reminder_push: body.todo_reminder_push ?? (cur ? cur.todo_reminder_push === 1 : true),
    tz: hasTz ? (body.tz as string) : (cur?.tz ?? null),
  };
  await c.env.DB.prepare(
    `INSERT INTO user_preferences (user_id, daily_review_push, todo_reminder_push, tz, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT (user_id) DO UPDATE SET daily_review_push = excluded.daily_review_push,
       todo_reminder_push = excluded.todo_reminder_push, tz = excluded.tz, updated_at = excluded.updated_at`
  )
    .bind(userId, next.daily_review_push ? 1 : 0, next.todo_reminder_push ? 1 : 0, next.tz)
    .run();
  return c.json(next);
});

// ---- Web Push: subscribe / unsubscribe / test ----
// GET /api/push/config — VAPID public key (empty = push not configured server-side)
app.get("/api/push/config", async (c) => {
  const subs = await userSubscriptions(c.env, c.get("userId"));
  return c.json({
    enabled: pushConfigured(c.env),
    vapid_public_key: c.env.VAPID_PUBLIC_KEY ?? null,
    subscriptions: subs.map((s) => ({ endpoint: s.endpoint, tz: s.tz, ua: s.ua, created_at: s.created_at })),
  });
});

// POST /api/push/subscribe — store (or refresh) one browser subscription; multi-device OK
app.post("/api/push/subscribe", async (c) => {
  if (!pushConfigured(c.env)) return c.json({ error: "服务端未配置推送" }, 503);
  const body = await c.req
    .json<{ endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; tz?: unknown; ua?: unknown }>()
    .catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  const p256dh = typeof body?.keys?.p256dh === "string" ? body.keys.p256dh : "";
  const auth = typeof body?.keys?.auth === "string" ? body.keys.auth : "";
  if (!endpoint.startsWith("https://") || endpoint.length > 1024 || !p256dh || !auth)
    return c.json({ error: "订阅数据不完整" }, 400);
  const tz = typeof body?.tz === "string" && body.tz.length <= 64 ? body.tz : null;
  const ua = typeof body?.ua === "string" ? body.ua.slice(0, 120) : null;
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, tz, ua) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
       auth = excluded.auth, tz = excluded.tz, ua = excluded.ua`
  )
    .bind(crypto.randomUUID(), c.get("userId"), endpoint, p256dh, auth, tz, ua)
    .run();
  return c.json({ ok: true });
});

// POST /api/push/unsubscribe — remove this browser's subscription
app.post("/api/push/unsubscribe", async (c) => {
  const body = await c.req.json<{ endpoint?: unknown }>().catch(() => null);
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
  if (!endpoint) return c.json({ error: "缺少 endpoint" }, 400);
  await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
    .bind(c.get("userId"), endpoint)
    .run();
  return c.json({ ok: true });
});

// POST /api/push/test — send a test notification to all of the caller's subscriptions
app.post("/api/push/test", async (c) => {
  if (!pushConfigured(c.env)) return c.json({ error: "服务端未配置推送" }, 503);
  const delivered = await sendPushToUser(c.env, c.get("userId"), {
    title: "🔔 碎念测试推送",
    body: "看到这条说明浏览器通知已就绪",
    url: "/#/settings",
    tag: "test",
  });
  if (delivered === 0) return c.json({ error: "没有可用订阅或推送失败，请先在本设备开启通知" }, 400);
  return c.json({ ok: true, delivered });
});

// ---- GET /api/todos/today ----
// 当天（用户时区）到期 + 已过期的未完成待办，供 bridge 上午推送清单
app.get("/api/todos/today", async (c) => {
  const tz = await loadUserTz(c.env, c.get("userId"));
  const today = zonedDate(new Date(), tz).iso;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL
       AND category = 'todo' AND (todo_done IS NULL OR todo_done = 0)
       AND todo_due IS NOT NULL AND date(todo_due) <= ?
     ORDER BY datetime(todo_due) ASC LIMIT 50`
  )
    .bind(c.get("userId"), today)
    .all<NoteRow>();
  const items = (results ?? []).map((n) => ({ ...noteToJson(n), overdue: (n.todo_due ?? "").slice(0, 10) < today }));
  return c.json({ date: today, items });
});

// ---- GET /api/reports ----
app.get("/api/reports", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, week_start, period, created_at FROM weekly_reports WHERE user_id = ? ORDER BY week_start DESC LIMIT 100"
  )
    .bind(c.get("userId"))
    .all<{ id: string; week_start: string; period: string; created_at: string }>();
  return c.json({ reports: results ?? [] });
});

// ---- GET /api/reports/:id ----
app.get("/api/reports/:id", async (c) => {
  const report = await c.env.DB.prepare("SELECT * FROM weekly_reports WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .first<WeeklyReportRow>();
  if (!report) return c.json({ error: "not found" }, 404);
  return c.json({ report });
});

// ---- POST /api/reports/generate (manual trigger) ----
app.post("/api/reports/generate", async (c) => {
  const body = await c.req.json<{ week?: string; period?: string; which?: string }>().catch(() => null);
  const period = body?.period === "month" ? "month" : "week";
  // 空参默认生成当前周期，与 Web「生成本周报告」同口径（R134 P2-3）；
  // 传 "last" 才生成上一完整周期（周一凌晨 cron 走的是 reports.ts 默认值，不受此影响）
  const which = (body?.which ?? body?.week) === "last" ? "last" : "this";
  const generated = await generatePeriodReport(c.env, c.get("userId"), new Date(), which, period);
  if (!generated) {
    const unit = period === "month" ? (which === "this" ? "本月" : "上个月") : which === "this" ? "本周" : "上周";
    return c.json({ error: which === "this" ? `${unit}还没有记录，先去记几条碎念吧` : `${unit}没有记录，暂无内容可总结` }, 422);
  }
  const { id, week_start } = generated;
  const report = await c.env.DB.prepare("SELECT * FROM weekly_reports WHERE id = ?").bind(id).first<WeeklyReportRow>();
  return c.json({ report, week_start }, 201);
});

// ---- POST /api/import ----
// Bulk-import notes from Cubox / flomo / Markdown / plain-text export files.
// Inserts rows with category NULL so the existing cron sweep gradually runs
// triage / embeddings / graph / link extraction without bursting AI quota.
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

app.post("/api/import", async (c) => {
  const userId = c.get("userId");
  // 批量入库按次限频（R122 P1-5）：泄露 token 也无法用导入绕过写入限流狂灌 AI 管线
  if (!(await checkRateLimit(c.env.DB, "bulk_ingest", [userId], BULK_INGEST_RATE_LIMIT_MAX))) {
    return c.json({ error: "导入太频繁了，请稍等一分钟再试", retryable: true }, 429);
  }
  const isZipSource = (s: string) => ZIP_IMPORT_SOURCES.includes(s as ImportSource);
  let source = "";
  let text = "";
  let zipBytes: Uint8Array | null = null;
  const ct = c.req.header("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await c.req.raw.formData().catch(() => null);
    if (!form) return c.json({ error: "invalid form data" }, 400);
    source = String(form.get("source") ?? "");
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
    if (file.size > MAX_IMPORT_BYTES) return c.json({ error: "文件过大：最大支持 20MB" }, 413);
    if (isZipSource(source)) {
      zipBytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
        if (source === "flomo") {
          // flomo 导出 zip（HTML + file/ 图片）：走 zip 解析管线，图片入 R2 不再丢弃
          zipBytes = bytes;
        } else {
          return c.json({ error: "该来源不支持 zip 文件，请选择 flomo / Notion / Obsidian / Apple 备忘录来源上传 zip" }, 400);
        }
      } else {
        text = new TextDecoder().decode(bytes);
      }
    }
  } else {
    const body = await c.req.json<{ source?: unknown; content?: unknown }>().catch(() => null);
    source = typeof body?.source === "string" ? body.source : "";
    if (isZipSource(source)) return c.json({ error: "该来源需以 multipart 表单上传 zip 文件" }, 400);
    text = typeof body?.content === "string" ? body.content : "";
    if (text.length > MAX_IMPORT_BYTES) return c.json({ error: "内容过大：最大支持 20MB" }, 413);
  }
  if (!IMPORT_SOURCES.includes(source as ImportSource)) {
    // R143 P2-4: a source passed as a query parameter is silently ignored and
    // used to produce a misleading "invalid source" error — call it out
    if (!source && IMPORT_SOURCES.includes((c.req.query("source") ?? "") as ImportSource)) {
      return c.json({ error: "source 需放在表单字段或 JSON body 中，不支持 query 参数" }, 400);
    }
    return c.json({ error: "source 需为 cubox / flomo / markdown / text / notion / obsidian / apple-notes 之一" }, 400);
  }

  let items: ImportItem[];
  let parseFailures: ImportFailure[] = [];
  // 丢弃可观测（R130 P2-2/P2-3）：超限图片与 2000 条截断都必须在结果里持平上报
  let assetsDropped = 0;
  let truncated = false;
  if (zipBytes) {
    const parsed = parseImportZip(source as ZipImportSource, zipBytes);
    items = parsed.items;
    parseFailures = parsed.failures;
    assetsDropped = parsed.assets_dropped;
    truncated = parsed.truncated;
  } else {
    if (!text.trim()) return c.json({ error: "文件内容为空" }, 400);
    items = parseImportFile(source as ImportSource, text);
    // 文本解析器在上限处停止：恰好到顶即视为可能截断，提示分批导入
    truncated = items.length >= MAX_IMPORT_ITEMS;
  }
  if (items.length === 0) {
    const reason = parseFailures[0]?.reason;
    return c.json({ error: reason ?? "未能从文件中解析出笔记，请确认选择的来源与导出格式是否匹配" }, 400);
  }

  // ?stream=1: NDJSON progress lines ({"done","total"}) followed by a final
  // line with {stats, failed_items}; keeps big zips responsive in the UI.
  if (c.req.query("stream") === "1") {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const writeLine = (obj: unknown) => writer.write(enc.encode(`${JSON.stringify(obj)}\n`)).catch(() => {});
    const run = (async () => {
      try {
        await writeLine({ done: 0, total: items.length });
        const result = await runImport(c.env, userId, source as ImportSource, items, {
          onProgress: (done, total) => void writeLine({ done, total }),
        });
        // imported notes carry historical created_at behind the backfill
        // cursor, so rewind it to let cron clustering pick them up
        if (result.stats.imported > 0) await resetThreadBackfill(c.env, userId);
        await writeLine({ stats: { ...result.stats, assets_dropped: assetsDropped, truncated }, failed_items: [...parseFailures, ...result.failures] });
      } catch (e) {
        await writeLine({ error: e instanceof Error ? e.message : "导入失败" });
      } finally {
        await writer.close().catch(() => {});
      }
    })();
    c.executionCtx.waitUntil(run);
    return c.body(readable, 201, {
      "content-type": "application/x-ndjson; charset=utf-8",
      // no-transform keeps CDN compression from buffering the whole stream,
      // which would deliver every progress line at once when the import ends
      "cache-control": "no-transform",
      "content-encoding": "identity",
    });
  }

  const result = await runImport(c.env, userId, source as ImportSource, items);
  if (result.stats.imported > 0) await resetThreadBackfill(c.env, userId);
  return c.json({ ...result.stats, assets_dropped: assetsDropped, truncated, failed_items: [...parseFailures, ...result.failures] }, 201);
});

// ---- GET /api/export ----
app.get("/api/export", async (c) => {
  const userId = c.get("userId");
  // sensitive notes are redacted by default; ?include_sensitive=true exports plaintext
  const includeSensitive = c.req.query("include_sensitive") === "true";
  const [notesR, threadsR, reportsR] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM notes WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC").bind(userId).all<NoteRow>(),
    c.env.DB.prepare("SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC").bind(userId).all<ThreadRow>(),
    c.env.DB.prepare("SELECT * FROM weekly_reports WHERE user_id = ? ORDER BY week_start DESC").bind(userId).all<WeeklyReportRow>(),
  ]);
  // every note is exported, including ones still waiting for AI triage
  // (category stays null). Fail-closed: a redacted export also redacts pending
  // notes whose content merely hints at credentials — the model hasn't judged
  // them yet, so plaintext must not leave this path either
  const exportable = notesR.results ?? [];
  const notes = await Promise.all(
    exportable.map((n) => {
      if (!includeSensitive && (n.is_sensitive || (n.category === null && maybeSensitive(n.content)))) {
        // 脱敏口径覆盖派生明文闭包（R126 P1-1）：正文/标题/标签之外，
        // meta 里的转写/描述/摘录与 url_title/url_summary 一并不出境
        const scrubbed = scrubDerivedMeta(parseNoteMeta(n.meta));
        return Promise.resolve(
          noteToJson({
            ...n,
            content: SENSITIVE_EXPORT_PLACEHOLDER,
            title: SENSITIVE_EXPORT_PLACEHOLDER,
            tags: "[]",
            is_sensitive: 1,
            url_title: null,
            url_summary: null,
            url_titles: null,
            meta: scrubbed ? JSON.stringify(scrubbed) : null,
          })
        );
      }
      return noteToJsonDecrypted(c.env, n);
    })
  );
  const threads = threadsR.results ?? [];
  const reports = reportsR.results ?? [];

  const format = c.req.query("format");
  if (format === "markdown" || format === "md") {
    let md = `# 碎念全量导出（${new Date().toISOString().slice(0, 10)}）\n\n共 ${notes.length} 条笔记、${threads.length} 条线索、${reports.length} 份周报。\n\n## 笔记\n`;
    for (const n of notes) {
      md += `\n### ${n.title || n.content.slice(0, 30)}\n- 时间：${n.created_at} | 分类：${CATEGORY_LABEL[n.category ?? ""] ?? n.category ?? "未分拣"} | 标签：${(n.tags as string[]).join(", ") || "无"}${n.url ? ` | 链接：${n.url}` : ""}\n\n${n.content}\n`;
    }
    md += `\n## 思考线索\n`;
    for (const t of threads) md += `\n### ${t.title}（${t.note_count} 条）\n${t.summary ?? ""}\n`;
    md += `\n## 周报\n`;
    for (const r of reports) md += `\n---\n\n${r.content_md}\n`;
    return c.body(md, 200, {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="suinian-export.md"`,
    });
  }
  return c.json({
    exported_at: new Date().toISOString(),
    notes,
    threads,
    reports,
  });
});

// ---- GET /api/backup ----
// Full backup zip: manifest + notes.json (all fields) + threads/reports +
// media/ originals streamed from R2. Sensitive notes redacted unless
// ?include_sensitive=true (same policy as /api/export).
app.get("/api/backup", async (c) => {
  const includeSensitive = c.req.query("include_sensitive") === "true";
  return buildBackupZip(c.env, c.get("userId"), includeSensitive, (p) => c.executionCtx.waitUntil(p));
});

// ---- POST /api/backup/restore ----
// Restore a backup zip: notes keep original time/tags/category, media
// re-uploaded to R2 under the new note ids, duplicates skipped.
app.post("/api/backup/restore", async (c) => {
  // 批量入库按次限频（R122 P1-5）：与导入共用 bulk_ingest 限额
  if (!(await checkRateLimit(c.env.DB, "bulk_ingest", [c.get("userId")], BULK_INGEST_RATE_LIMIT_MAX))) {
    return c.json({ error: "恢复操作太频繁了，请稍等一分钟再试", retryable: true }, 429);
  }
  const ct = c.req.header("content-type") || "";
  let stream: ReadableStream<Uint8Array> | null = null;
  if (ct.includes("multipart/form-data")) {
    const form = await c.req.raw.formData().catch(() => null);
    if (!form) return c.json({ error: "invalid form data" }, 400);
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
    if (file.size > MAX_RESTORE_BYTES) {
      return c.json({ error: `备份文件过大：最大支持 ${MAX_RESTORE_BYTES / 1024 / 1024}MB` }, 413);
    }
    stream = file.stream() as ReadableStream<Uint8Array>;
  } else {
    stream = c.req.raw.body;
  }
  if (!stream) return c.json({ error: "file required" }, 400);
  const result = await restoreBackup(c.env, c.get("userId"), stream, (p) => c.executionCtx.waitUntil(p));
  if ("error" in result) return c.json({ error: result.error }, result.status);
  await resetThreadBackfill(c.env, c.get("userId"));
  return c.json(result, 201);
});

// ---- MCP (Model Context Protocol) endpoint: /mcp, Streamable HTTP ----
registerMcpRoute(app);

export { app };

/** Concurrent LLM triage calls per retriage round (IO-bound, well under provider limits). */
const RETRIAGE_CONCURRENCY = 5;
/**
 * Retriage attempts after which a note stops being retried (R132, from
 * audit-r131 §3.1: 9 corpus notes cycled 「分拣延迟，将自动重试」 forever). The
 * note keeps its fallback category and needs_retriage is cleared so the sweep
 * and the UI treat it as sorted; the user can still edit the category by hand.
 */
const RETRIAGE_MAX_ATTEMPTS = 8;


async function retriageOne(
  env: Env,
  row: { id: string; user_id: string; content: string; content_enc: string | null; created_at: string }
): Promise<boolean> {
  // pre-encrypted pending notes store a placeholder: triage the plaintext
  let content = row.content;
  if (row.content_enc && env.SUINIAN_ENC_KEY) {
    const plain = await decryptContent(env.SUINIAN_ENC_KEY, row.content_enc);
    if (plain !== null) content = plain;
  }
  const topTags = await loadTopTags(env.DB, row.user_id).catch(() => [] as string[]);
  const corrections = await loadCategoryCorrections(env.DB, row.user_id).catch(() => []);
  const tz = await loadUserTz(env, row.user_id);
  // 历史/导入笔记的相对日期以笔记原始记录时间为锚点，不随分拣执行日漂移
  const noteTime = new Date(Date.parse(`${row.created_at.replace(" ", "T")}Z`));
  const anchor = Number.isFinite(noteTime.getTime()) ? noteTime : new Date();
  const triage = await triageNote(content, env, topTags, tz, corrections, anchor);
  if (!triage) {
    // the whole AI chain is down: after a grace period stop showing the user a
    // spinner forever — give the note the fallback category and mark it so the
    // sweep re-triages it once AI recovers, but only up to RETRIAGE_MAX_ATTEMPTS
    // times so a note the model can never triage reaches a terminal state
    if (Date.now() - Date.parse(`${row.created_at.replace(" ", "T")}Z`) > TRIAGE_DEGRADE_AFTER_MS) {
      await env.DB.prepare(
        `UPDATE notes SET category = coalesce(category, ?), meta = json_set(coalesce(meta, '{}'),
           '$.retriage_attempts', coalesce(json_extract(meta, '$.retriage_attempts'), 0) + 1,
           '$.needs_retriage', json(CASE WHEN coalesce(json_extract(meta, '$.retriage_attempts'), 0) + 1 >= ? THEN 'false' ELSE 'true' END)),
           updated_at = datetime('now') WHERE id = ?`
      )
        .bind(FALLBACK_TRIAGE.category, RETRIAGE_MAX_ATTEMPTS, row.id)
        .run();
    }
    return false;
  }
  await applyTriage(env, row.id, triage, content);
  const n = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(row.id).first<NoteRow>();
  if (n) {
    await extractGraph(env, n);
    const tid = await clusterNote(env, n).catch((err) => {
      console.error("retriage: cluster failed", err);
      return null;
    });
    await upsertNoteEmbedding(env, n);
    if (tid) await mergeDuplicateThreads(env, n.user_id, tid);
  }
  return true;
}

/**
 * Re-triage notes the AI failed to sort (category still NULL), oldest first.
 * Each round pulls `limit` notes and triages them with bounded concurrency;
 * with a time budget it keeps draining rounds until the backlog is empty, the
 * budget is spent, or the AI stops responding — so a 3000-note import is
 * sorted within hours instead of weeks. `userId` scopes the sweep to one
 * user (the opportunistic kick from GET /api/notes).
 */
export async function retriageUnsorted(env: Env, limit = 10, timeBudgetMs = 0, userId?: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT id, user_id, content, content_enc, created_at FROM notes WHERE (category IS NULL OR json_extract(meta, '$.needs_retriage') = 1) AND deleted_at IS NULL AND created_at < datetime('now', '-1 minutes')${userId ? " AND user_id = ?" : ""} ORDER BY (category IS NULL) DESC, created_at ASC LIMIT ?`
    )
      .bind(...(userId ? [userId, limit] : [limit]))
      .all<{ id: string; user_id: string; content: string; content_enc: string | null; created_at: string }>();
    const rows = results ?? [];
    if (rows.length === 0) break;
    let triaged = 0;
    for (let i = 0; i < rows.length; i += RETRIAGE_CONCURRENCY) {
      const group = rows.slice(i, i + RETRIAGE_CONCURRENCY);
      const settled = await Promise.allSettled(group.map((row) => retriageOne(env, row)));
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value) triaged++;
        else if (s.status === "rejected") console.error("retriage: note failed", s.reason);
      }
      if (timeBudgetMs > 0 && Date.now() - started >= timeBudgetMs) break;
    }
    // AI unavailable (nothing triaged): stop instead of spinning on the same rows
    if (triaged === 0) break;
    if (rows.length < limit) break;
    if (Date.now() - started >= timeBudgetMs) break;
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "0 0 * * 1") {
      // Monday 08:00 Asia/Shanghai = Monday 00:00 UTC -> weekly reports
      ctx.waitUntil(generateAllWeeklyReports(env));
    } else if (event.cron === "0 0 1 * *") {
      // 1st of the month 08:00 Asia/Shanghai = 00:00 UTC -> last month's reports
      ctx.waitUntil(generateAllMonthlyReports(env));
    } else if (event.cron === "*/10 * * * *") {
      // sweep notes whose async triage failed or was cancelled (time-budgeted:
      // keeps draining big import backlogs until ~8 min are spent)
      ctx.waitUntil(retriageUnsorted(env, 25, RETRIAGE_TIME_BUDGET_MS));
      // backfill article extraction for link notes (a few per run, rate-limited)
      ctx.waitUntil(backfillLinkExtracts(env));
      // backfill embeddings for notes that predate semantic search (batched + budgeted)
      ctx.waitUntil(backfillEmbeddings(env, 20, EMBED_BACKFILL_BUDGET_MS));
      // backfill graph extraction for notes that predate the knowledge graph (rate-limited)
      ctx.waitUntil(backfillGraphExtracts(env));
      // hard-delete soft-deleted notes past their undo window (attachments/vectors/graph too)
      ctx.waitUntil(purgeExpiredSoftDeletes(env, ctx));
      // full-history thread clustering: advance each user's cursor over old ideas
      ctx.waitUntil(backfillThreadClusters(env));
      // deferred duplicate-thread merge: heal concurrent same-topic splits once embeddings are ready
      ctx.waitUntil(sweepRecentDuplicateThreads(env));
      // resume queued/stale async rebuild jobs (survives the request-side slice dying)
      ctx.waitUntil(resumeThreadJobs(env));
      // web push: todo due reminders (at most once per todo) + daily review push (once per user per local day)
      ctx.waitUntil(sweepTodoReminders(env));
      ctx.waitUntil(sweepDailyReviewPush(env));
      // drop auth rate-limit rows whose fixed window closed over a day ago
      ctx.waitUntil(sweepAuthRateLimits(env.DB));
    } else {
      // daily thread title/summary refresh + daily review generation
      ctx.waitUntil(refreshThreads(env));
      ctx.waitUntil(generateAllDailyReviews(env));
      // daily R2↔attachments reconciliation: GC orphan media objects
      ctx.waitUntil(reconcileMediaOrphans(env));
    }
  },
};
