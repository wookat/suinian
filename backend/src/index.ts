import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, NoteMeta, NoteRow, ThreadRow, TriageResult, WeeklyReportRow } from "./types";
import { triageNote, loadTopTags, normalizeTodoDue, detectSensitive, FALLBACK_TRIAGE } from "./triage";
import { extractUrl, extractUrls, fetchLinkMeta } from "./linkmeta";
import { encryptContent, decryptContent, ENC_PLACEHOLDER } from "./crypto";
import { encodeCursor, decodeCursor } from "./cursor";
import { enrichLinkInto, backfillLinkExtracts } from "./extract";
import { clusterNote, refreshThreads, reconcileThreads } from "./threads";
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
import { chatComplete } from "./ai";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  validateName,
  validatePassword,
  registrationEnabled,
  checkRateLimit,
  clientIp,
} from "./auth";
import { generatePeriodReport, generateAllWeeklyReports, generateAllMonthlyReports } from "./reports";
import { getTodayReview, generateAllDailyReviews, readCronHeartbeats, shanghaiDate } from "./review";
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
  AUDIO_FAILED_PLACEHOLDER,
  IMAGE_FAILED_PLACEHOLDER,
} from "./media";
import { detectFileKind, buildFileNote, buildFileReply } from "./files";
import { parseImportFile, runImport, IMPORT_SOURCES, ZIP_IMPORT_SOURCES, type ImportSource, type ImportItem, type ImportFailure } from "./import";
import { parseImportZip, type ZipImportSource } from "./import-zip";
import { registerMcpRoute } from "./mcp";
import { buildBackupZip, restoreBackup, MAX_RESTORE_BYTES } from "./backup";
import { parseTimeRange, inTimeRange, isRefusalAnswer, buildNoAnswerResponse } from "./ask";
import { pushConfigured, sendPushToUser, userSubscriptions, sweepTodoReminders, sweepDailyReviewPush } from "./push";
import { PIPELINE_TIMEOUT_MS, SENSITIVE_EXPORT_PLACEHOLDER } from "./constants";
import { buildStats, normalizeTzOffset, SAMPLE_TAG_LIKE } from "./stats";

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
  console.error("unhandled error:", err);
  return c.json({ error: "internal error" }, 500);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

const MAX_CONTENT_CHARS = 20_000;

function contentTooLong(c: { json: (o: object, s: 413) => Response }, content: string): Response | null {
  if (content.length <= MAX_CONTENT_CHARS) return null;
  return c.json(
    { error: `内容过长：最多 ${MAX_CONTENT_CHARS} 字符，当前 ${content.length} 字符。请拆成多条或精简后再发。` },
    413
  );
}

app.get("/", (c) => c.json({ name: "suinian-api", status: "ok" }));
app.get("/health", (c) => c.json({ ok: true }));

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
    if (/UNIQUE/i.test(msg)) return c.json({ error: "用户名已存在", code: "NAME_TAKEN" }, 409);
    return c.json({ error: "注册失败（数据库写入出错），请重试", code: "DB_WRITE_FAILED" }, 500);
  }
  console.log(`register: created ${id} in ${Date.now() - started}ms`);
  return c.json({ user: { id, name }, api_token: token }, 201);
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

function parseNoteMeta(raw: string | null): NoteMeta | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as NoteMeta;
    return typeof obj === "object" && obj !== null ? obj : null;
  } catch {
    return null;
  }
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

const CATEGORY_LABEL: Record<string, string> = {
  idea: "想法",
  todo: "待办",
  collect: "收藏",
  data: "资料",
  expense: "支出",
  income: "收入",
};

export async function applyTriage(env: Env, noteId: string, triage: TriageResult, content: string): Promise<void> {
  // imported notes carry their original tags in meta.import_tags: keep them
  // first and union in the AI-suggested ones
  const row = await env.DB.prepare("SELECT meta, todo_due FROM notes WHERE id = ?")
    .bind(noteId)
    .first<{ meta: string | null; todo_due: string | null }>();
  const meta = parseNoteMeta(row?.meta ?? null);
  const override = meta?.manual_override;
  const importTags = meta?.import_tags;
  const tags = Array.isArray(importTags)
    ? [...new Set([...importTags, ...triage.tags])].slice(0, 6)
    : triage.tags;
  const sets = ["is_sensitive = ?"];
  const binds: unknown[] = [triage.is_sensitive ? 1 : 0];
  // fields the user set by hand stay untouched
  if (!override?.title) {
    sets.push("title = ?");
    binds.push(triage.title || null);
  }
  if (!override?.todo_due) {
    // AI only fills a missing due; an already-set due is never cleared or replaced
    sets.push("todo_due = ?");
    binds.push(row?.todo_due ?? triage.todo_due ?? null);
  }
  if (!override?.category) {
    sets.push("category = ?", "amount = ?", "currency = ?");
    binds.push(triage.category, triage.amount ?? null, triage.currency ?? null);
    if (triage.merchant) {
      sets.push("meta = ?");
      binds.push(JSON.stringify({ ...(meta ?? {}), finance_merchant: triage.merchant }));
    }
  }
  if (!override?.tags) {
    sets.push("tags = ?");
    binds.push(JSON.stringify(tags));
  }
  if (triage.is_sensitive && env.SUINIAN_ENC_KEY) {
    // encrypt-at-rest: ciphertext into content_enc, plaintext replaced by a placeholder
    const enc = await encryptContent(env.SUINIAN_ENC_KEY, content);
    sets.push("content = ?", "content_enc = ?");
    binds.push(ENC_PLACEHOLDER, enc);
  }
  await env.DB.prepare(`UPDATE notes SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...binds, noteId)
    .run();
}

async function fetchLinkMetaInto(env: Env, noteId: string, urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const metas = await Promise.all(urls.map((u) => fetchLinkMeta(u)));
  const first = metas[0];
  const urlTitles = urls.map((u, i) => ({ url: u, title: metas[i].title }));
  if (first.title || first.description || urlTitles.some((t) => t.title)) {
    await env.DB.prepare(
      "UPDATE notes SET url_title = ?, url_summary = ?, url_titles = ?, updated_at = datetime('now') WHERE id = ?"
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
  // manual so neither the sync triage nor the cron sweep re-sorts it
  const meta: NoteMeta | null =
    opts.skipTriage || manualTags.length > 0
      ? {
          ...(body.meta ?? {}),
          manual_override: { ...(opts.skipTriage ? { category: true } : {}), ...(manualTags.length > 0 ? { tags: true } : {}) },
        }
      : (body.meta ?? null);

  // sync sensitive pre-check (regex, no AI call): obvious credential values are
  // encrypted from the very first write, so the pre-triage window never serves
  // their plaintext through backup/export/MCP/list paths
  let storedContent = content;
  let preContentEnc: string | null = null;
  let preSensitive = false;
  if (detectSensitive(content) && c.env.SUINIAN_ENC_KEY) {
    try {
      preContentEnc = await encryptContent(c.env.SUINIAN_ENC_KEY, content);
      storedContent = ENC_PLACEHOLDER;
      preSensitive = true;
    } catch {
      preContentEnc = null;
    }
  }

  // insert immediately (category resolved by triage, sync or async)
  await c.env.DB.prepare(
    `INSERT INTO notes (id, user_id, source, raw_type, content, url, category, tags, meta, is_sensitive, content_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      source,
      rawType,
      storedContent,
      url ?? null,
      opts.skipTriage ? "idea" : null,
      JSON.stringify(manualTags),
      meta ? JSON.stringify(meta) : null,
      preSensitive ? 1 : 0,
      preContentEnc
    )
    .run();

  const runTriage = async (): Promise<TriageResult | null> => {
    const topTags = await loadTopTags(c.env.DB, userId).catch(() => [] as string[]);
    const triage = await triageNote(content, c.env, topTags);
    // null = AI unavailable: keep category NULL so the cron sweep retries later
    if (triage) await applyTriage(c.env, id, triage, content);
    return triage;
  };

  // link metadata always in background; full article extraction + AI summary
  // runs after triage so the tag merge never races with applyTriage
  if (urls.length > 0) waitUntil(capped(fetchLinkMetaInto(c.env, id, urls), PIPELINE_TIMEOUT_MS, `linkmeta note=${id}`));

  const runPipeline = async (withTriage: boolean) => {
    if (withTriage) await runTriage();
    const n = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
    if (n) {
      await extractGraph(c.env, n);
      await clusterNote(c.env, n);
      await upsertNoteEmbedding(c.env, n);
    }
    if (url) await enrichLinkInto(c.env, id);
  };

  let triage: TriageResult | null = null;
  if (opts.skipTriage) {
    waitUntil(capped(runPipeline(false), PIPELINE_TIMEOUT_MS, `pipeline note=${id}`));
  } else if (opts.syncTriage) {
    triage = await runTriage();
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
  if (!body || !(body.content ?? "").trim()) return c.json({ error: "content required" }, 400);
  const tooLong = contentTooLong(c, body.content ?? "");
  if (tooLong) return tooLong;
  // skip_triage (`!` inline command): store as-is, never re-sorted
  const skipTriage = body.skip_triage === true;
  // returns immediately; triage + link fetch + clustering backfill asynchronously
  const { note } = await createNote(c, c.get("userId"), body, (p) => c.executionCtx.waitUntil(p), { syncTriage: false, skipTriage });
  return c.json({ note: await noteToJsonDecrypted(c.env, note) }, 201);
});

// Shared filter SQL for GET /api/notes and POST /api/notes/batch: category /
// tag / keyword / source / created_at range, all combinable.
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

/** Split a keyword query into up to 5 whitespace-separated terms. */
export function searchTerms(q: string): string[] {
  return q.split(/\s+/).filter(Boolean).slice(0, 5);
}

const KEYWORD_FIELDS = ["content", "title", "url_title", "url_summary"] as const;

function termCond(): string {
  return `(${KEYWORD_FIELDS.map((f) => `${f} LIKE ?`).join(" OR ")})`;
}

/** How many of the query terms a note matches across the searchable fields. */
export function matchedTermCount(
  note: { content: string; title: string | null; url_title: string | null; url_summary: string | null },
  terms: string[]
): number {
  const hay = [note.content, note.title, note.url_title, note.url_summary]
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
      binds.push(like, like, like, like);
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
      const termBinds = terms.flatMap((t) => Array(4).fill(`%${t}%`) as string[]);
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
    const notes = await Promise.all(
      merged.map(async (n) => ({
        ...(await noteToJsonDecrypted(c.env, n)),
        match:
          kwIds.has(n.id) || partialIds.has(n.id) ? (semScore.has(n.id) ? "both" : "keyword") : "semantic",
      }))
    );
    return c.json({ notes, next_cursor: next });
  }

  const notes = await Promise.all(page.map((n) => noteToJsonDecrypted(c.env, n)));
  return c.json({ notes, next_cursor: next });
});

// ---- PATCH /api/notes/:id ----
app.patch("/api/notes/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid body" }, 400);

  const existing = await c.env.DB.prepare(
    "SELECT is_sensitive, content, content_enc, meta FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  )
    .bind(id, userId)
    .first<{ is_sensitive: number; content: string; content_enc: string | null; meta: string | null }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const wantSensitive =
    typeof body.is_sensitive === "boolean" ? body.is_sensitive : !!existing.is_sensitive;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof body.content === "string") {
    if (!body.content.trim()) return c.json({ error: "内容不能为空，如需删除请用删除操作" }, 400);
    const tooLong = contentTooLong(c, body.content);
    if (tooLong) return tooLong;
    if (wantSensitive && c.env.SUINIAN_ENC_KEY) {
      sets.push("content = ?", "content_enc = ?");
      binds.push(ENC_PLACEHOLDER, await encryptContent(c.env.SUINIAN_ENC_KEY, body.content));
    } else {
      sets.push("content = ?", "content_enc = ?");
      binds.push(body.content, null);
    }
  } else if (typeof body.is_sensitive === "boolean" && body.is_sensitive !== !!existing.is_sensitive) {
    if (wantSensitive) {
      // mark sensitive: encrypt the current plaintext at rest
      if (c.env.SUINIAN_ENC_KEY) {
        sets.push("content = ?", "content_enc = ?");
        binds.push(ENC_PLACEHOLDER, await encryptContent(c.env.SUINIAN_ENC_KEY, existing.content));
      }
    } else {
      // unmark sensitive: restore plaintext from ciphertext (or keep stored content)
      const plain =
        existing.content_enc && c.env.SUINIAN_ENC_KEY
          ? await decryptContent(c.env.SUINIAN_ENC_KEY, existing.content_enc)
          : null;
      sets.push("content = ?", "content_enc = ?");
      binds.push(plain ?? existing.content, null);
    }
  }
  if (typeof body.is_sensitive === "boolean") {
    sets.push("is_sensitive = ?");
    binds.push(body.is_sensitive ? 1 : 0);
  }
  if (typeof body.todo_done === "boolean") {
    sets.push("todo_done = ?", "done_at = ?");
    binds.push(body.todo_done ? 1 : 0, body.todo_done ? new Date().toISOString() : null);
  }
  const override: { category?: boolean; tags?: boolean; todo_due?: boolean; title?: boolean } = {};
  if (typeof body.category === "string" && ["idea", "todo", "collect", "data", "expense", "income"].includes(body.category)) {
    sets.push("category = ?");
    binds.push(body.category);
    override.category = true;
  }
  if (Array.isArray(body.tags)) {
    sets.push("tags = ?");
    binds.push(JSON.stringify(body.tags.filter((t) => typeof t === "string")));
    override.tags = true;
  }
  if (typeof body.title === "string") {
    sets.push("title = ?");
    binds.push(body.title);
    override.title = true;
  }
  if (typeof body.todo_due === "string" || body.todo_due === null) {
    sets.push("todo_due = ?");
    binds.push(normalizeTodoDue(body.todo_due));
    override.todo_due = true;
  }
  if (Object.keys(override).length > 0) {
    // remember the user's hand-set values so AI triage / cron never overwrites them
    const meta = parseNoteMeta(existing.meta) ?? {};
    meta.manual_override = { ...meta.manual_override, ...override };
    sets.push("meta = ?");
    binds.push(JSON.stringify(meta));
  }
  if (sets.length === 0) return c.json({ error: "no updatable fields" }, 400);
  sets.push("updated_at = datetime('now')");

  const res = await c.env.DB.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...binds, id, userId)
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  const note = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
  c.executionCtx.waitUntil(capped(upsertNoteEmbedding(c.env, note!), PIPELINE_TIMEOUT_MS, `patch-embed note=${id}`));
  const sensitivityChanged =
    typeof body.is_sensitive === "boolean" && body.is_sensitive !== !!existing.is_sensitive;
  // extractGraph purges graph rows for sensitive notes and (re-)extracts otherwise
  if (typeof body.content === "string" || sensitivityChanged)
    c.executionCtx.waitUntil(capped(extractGraph(c.env, note!), PIPELINE_TIMEOUT_MS, `patch-graph note=${id}`));
  // content changed without an explicit title: recompute the AI title so
  // search/export never keep showing the stale pre-edit title
  if (typeof body.content === "string" && body.content !== existing.content && typeof body.title !== "string")
    c.executionCtx.waitUntil(capped(recomputeTitle(c.env, id, body.content), PIPELINE_TIMEOUT_MS, `patch-title note=${id}`));
  return c.json({ note: await noteToJsonDecrypted(c.env, note!) });
});

/** Regenerate only the AI title after a content edit (never touches category/tags/due). */
export async function recomputeTitle(env: Env, noteId: string, content: string): Promise<void> {
  const row = await env.DB.prepare("SELECT meta FROM notes WHERE id = ?").bind(noteId).first<{ meta: string | null }>();
  if (parseNoteMeta(row?.meta ?? null)?.manual_override?.title) return;
  const triage = await triageNote(content, env);
  if (!triage || !triage.title) return;
  await env.DB.prepare("UPDATE notes SET title = ? WHERE id = ?").bind(triage.title, noteId).run();
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

/** Retention window (最近删除) before a soft-deleted note is hard-deleted by the cron sweep. */
export const SOFT_DELETE_RETENTION_DAYS = 30;
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

/** Run a batch action over id chunks, reporting progress after each chunk. Returns affected count. */
async function runBatchAction(
  env: Env,
  userId: string,
  action: string,
  ids: string[],
  opts: { tags: string[]; category: string },
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  let affected = 0;
  let done = 0;
  for (const chunk of chunkIds(ids)) {
    const ph = chunk.map(() => "?").join(",");
    if (action === "delete") {
      // soft delete: one UPDATE per chunk; the cron sweep hard-deletes (and
      // cleans attachments/vectors/graph) after the undo window
      const res = await env.DB.prepare(
        `UPDATE notes SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND deleted_at IS NULL AND id IN (${ph})`
      )
        .bind(userId, ...chunk)
        .run();
      affected += res.meta.changes ?? 0;
    } else if (action === "add_tags" || action === "remove_tags") {
      const r = await env.DB.prepare(
        `SELECT id, tags, meta FROM notes WHERE user_id = ? AND deleted_at IS NULL AND id IN (${ph})`
      )
        .bind(userId, ...chunk)
        .all<{ id: string; tags: string; meta: string | null }>();
      const stmts: D1PreparedStatement[] = [];
      for (const row of r.results ?? []) {
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
        const meta = parseNoteMeta(row.meta) ?? {};
        meta.manual_override = { ...meta.manual_override, tags: true };
        stmts.push(
          env.DB.prepare(
            "UPDATE notes SET tags = ?, meta = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
          ).bind(JSON.stringify(next), JSON.stringify(meta), row.id, userId)
        );
      }
      if (stmts.length > 0) await env.DB.batch(stmts);
      affected += stmts.length;
    } else if (action === "set_category") {
      const r = await env.DB.prepare(
        `SELECT id, meta FROM notes WHERE user_id = ? AND deleted_at IS NULL AND id IN (${ph})`
      )
        .bind(userId, ...chunk)
        .all<{ id: string; meta: string | null }>();
      const stmts: D1PreparedStatement[] = [];
      for (const row of r.results ?? []) {
        const meta = parseNoteMeta(row.meta) ?? {};
        meta.manual_override = { ...meta.manual_override, category: true };
        stmts.push(
          env.DB.prepare(
            "UPDATE notes SET category = ?, meta = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
          ).bind(opts.category, JSON.stringify(meta), row.id, userId)
        );
      }
      if (stmts.length > 0) await env.DB.batch(stmts);
      affected += stmts.length;
    }
    done += chunk.length;
    onProgress?.(done, ids.length);
  }
  return affected;
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
  if (action === "set_category" && !["idea", "todo", "collect", "data", "expense", "income"].includes(category))
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
        const affected = await runBatchAction(c.env, userId, action, ids, opts, (done, total) =>
          void writeLine({ done, total })
        );
        await writeLine(action === "delete" ? { ok: true, affected, remaining, ids } : { ok: true, affected, remaining });
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

  const affected = await runBatchAction(c.env, userId, action, ids, opts);
  // delete responses echo the targeted ids so the client can offer undo (restore)
  return c.json(action === "delete" ? { ok: true, affected, remaining, ids } : { ok: true, affected, remaining });
});

// ---- GET /api/tags ----
// All tags of the current user with usage counts, most used first.
// ---- GET /api/stats ----
// One-shot dashboard stats: heatmap daily counts, totals, distributions,
// streaks, top tags, thread count. tz_offset = minutes east of UTC (default +480).
app.get("/api/stats", async (c) => {
  const days = Math.max(1, Math.min(730, parseInt(c.req.query("days") ?? "", 10) || 365));
  const tzOffset = normalizeTzOffset(c.req.query("tz_offset"));
  const stats = await buildStats(c.env, c.get("userId"), { days, tzOffset });
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
  return c.json({ note: noteToJson(note) });
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
    "SELECT id, tags FROM notes WHERE user_id = ? AND deleted_at IS NULL AND tags LIKE ?"
  )
    .bind(userId, `%"${from}"%`)
    .all<{ id: string; tags: string }>();
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
    await env.DB.prepare("UPDATE notes SET tags = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .bind(JSON.stringify(next), row.id, userId)
      .run();
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
  const att = await c.env.DB.prepare("SELECT r2_key, mime FROM attachments WHERE note_id = ? ORDER BY rowid DESC LIMIT 1")
    .bind(id)
    .first<{ r2_key: string; mime: string | null }>();
  if (!att) return c.json({ error: "no attachment" }, 404);
  const obj = await c.env.MEDIA.get(att.r2_key);
  if (!obj) return c.json({ error: "attachment missing" }, 404);
  const fileName = parseNoteMeta(note.meta)?.file_name || att.r2_key.split("/").pop() || "file";
  return new Response(obj.body, {
    headers: {
      "Content-Type": att.mime || obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
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

// ---- POST /api/ingest/media ----
// audio -> Whisper transcription, image -> vision text extraction, file ->
// text extraction (+ AI summary for long docs); the extracted text becomes
// the note content and flows through the normal async triage pipeline.
app.post("/api/ingest/media", async (c) => {
  const parsed = await parseMediaRequest(c.req.raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status);

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
  }

  const tooLong = contentTooLong(c, content);
  if (tooLong) return tooLong;

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

/**
 * Build the /api/ask references array so that [n] citations in the answer map
 * to entries: each reference carries the exact `index` used in the answer
 * ([index] ↔ note id). Cited notes come first in citation order; when the
 * answer has no [n] citations, all recalled notes are returned with their
 * prompt indexes.
 */
export function buildAskReferences(
  answer: string,
  noteIds: string[]
): { index: number; note_id: string }[] {
  const cited: number[] = [];
  for (const m of answer.matchAll(/[\[［](\d{1,2})[\]］]/g)) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= noteIds.length && !cited.includes(n)) cited.push(n);
  }
  const order = cited.length > 0 ? cited : noteIds.map((_, i) => i + 1);
  return order.map((n) => ({ index: n, note_id: noteIds[n - 1] }));
}

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
  "你是检索关键词抽取器。从问题中抽取 2-6 个最能定位相关笔记的关键词（具体的名词、动词或专有名词，每个 2-6 个字），用空格分隔输出，不要任何标点、解释或前缀。忽略疑问词（什么/哪个/怎么/是啥/what/which/how）、时间词（今天/最近几天/上个月/去年/recently/last week）、代词和语气助词。若问题含英文词，除英文关键词外还要同时输出其中文对应词（因为笔记多为中文）。例如「最近几天收藏的那个咖啡视频讲什么」输出「咖啡 视频 收藏」；「What did I note about the coffee shop idea」输出「coffee shop 咖啡馆 点子」。";

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

// ---- POST /api/ask ----
app.post("/api/ask", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ question?: string; history?: unknown; graph?: unknown }>().catch(() => null);
  const question = (body?.question ?? "").trim();
  if (!question) return c.json({ error: "question required" }, 400);
  const history = sanitizeAskHistory(body?.history);
  const useGraph = body?.graph !== false; // graph:false disables GraphRAG expansion (A/B comparison)

  // query rewrite: resolve pronouns/ordinals against history, then keyword recall
  const recallQuestion = await rewriteAskQuestion(c.env, question, history);
  // explicit time scope ("上个月/最近一周/去年…") narrows recall to that window
  const timeRange = parseTimeRange(recallQuestion);
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
    const expansion = await graphExpand(c.env, userId, notes.map((n) => n.id), 5);
    graphTriples = expansion.triples;
    const missing = expansion.note_ids.filter((nid) => !notes.some((n) => n.id === nid));
    if (missing.length > 0) {
      const ph = missing.map(() => "?").join(",");
      const r = await c.env.DB.prepare(
        `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL AND id IN (${ph})`
      )
        .bind(userId, ...missing)
        .all<NoteRow>();
      for (const n of r.results ?? []) {
        graphNoteIds.add(n.id);
        notes.push(n);
      }
      notes = notes.slice(0, 20);
    }
  }
  if (notes.length === 0) {
    // nothing recalled at all: answer "没找到" honestly (never bluff over the
    // recent-20) and suggest the nearest notes below the semantic threshold
    const near = await semanticRecall(c.env, userId, recallQuestion, 3, 0.3);
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
    const { answer, references } = buildNoAnswerResponse(suggestions);
    const sugById = new Map(suggestions.map((n) => [n.id, n]));
    const refNotes = await Promise.all(
      references.map((r) => noteToJsonDecrypted(c.env, sugById.get(r.note_id)!))
    );
    return c.json({ answer, references, notes: refNotes, no_answer: true });
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
      const graphTag = graphNoteIds.has(n.id) ? ", 图谱关联" : "";
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
          "你是「碎念」个人笔记问答助手。根据下面用户的笔记片段回答问题，引用时用 [序号] 标注。每个片段括号里的日期是记录时间——问题限定了时间范围（如上个月/最近一周）时，只依据落在该范围内的片段作答；范围外的可提一句但要说明时间对不上。标注「图谱关联」的片段是沿知识图谱找到的强关联碎片，「实体关系」列出了笔记间的关系脉络——回答涉及跨碎片关联时请说明依据（如某想法的前提/支撑来自哪条）。可结合之前的对话上下文理解代词与省略。若笔记中没有能回答问题的信息，直接说没找到，绝不要编造或强行凑答案。回答用中文，简洁。",
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
  // the model itself concluded "没找到": swap the reference dump (uncited
  // recall context) for up to 3 nearest-by-semantic suggestions
  if (answer && isRefusalAnswer(answer)) {
    const ranked = [...notes].sort((a, b) => (semScore.get(b.id) ?? 0) - (semScore.get(a.id) ?? 0));
    const suggestions = ranked.filter((n) => (semScore.get(n.id) ?? 0) > 0).slice(0, 3);
    const { answer: noAnswer, references } = buildNoAnswerResponse(suggestions);
    const sugById = new Map(suggestions.map((n) => [n.id, n]));
    const refNotes = await Promise.all(
      references.map((r) => noteToJsonDecrypted(c.env, sugById.get(r.note_id)!))
    );
    return c.json({ answer: noAnswer, references, notes: refNotes, no_answer: true });
  }
  const references = buildAskReferences(answer ?? "", noteIds);
  const byId = new Map(notes.map((n) => [n.id, n]));
  const refNotes = await Promise.all(
    references.map((r) => noteToJsonDecrypted(c.env, byId.get(r.note_id)!))
  );
  if (!answer) {
    return c.json({ answer: "（AI 暂不可用）已找到相关记录，见 references。", references, notes: refNotes });
  }
  return c.json({ answer, references, notes: refNotes });
});

// ---- GET /api/threads ----
// last_note_at = newest fragment's created_at; the list sorts by it so that
// "recently written-into" threads rank first (updated_at is bumped by the
// daily summary refresh for every thread and doesn't reflect real activity).
app.get("/api/threads", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, (SELECT MAX(n.created_at) FROM notes n WHERE n.thread_id = t.id AND n.deleted_at IS NULL) AS last_note_at
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
  const ageMs = Date.now() - new Date(job.updated_at.replace(" ", "T") + "Z").getTime();
  if (job.status === "queued" || ageMs > 2 * 60_000) {
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
  const row = await c.env.DB.prepare("SELECT daily_review_push, todo_reminder_push FROM user_preferences WHERE user_id = ?")
    .bind(c.get("userId"))
    .first<{ daily_review_push: number; todo_reminder_push: number }>();
  return c.json({
    daily_review_push: row ? row.daily_review_push === 1 : true,
    todo_reminder_push: row ? row.todo_reminder_push === 1 : true,
  });
});

// ---- PATCH /api/preferences ----
app.patch("/api/preferences", async (c) => {
  const body = await c.req.json<{ daily_review_push?: boolean; todo_reminder_push?: boolean }>().catch(() => null);
  if (!body || (typeof body.daily_review_push !== "boolean" && typeof body.todo_reminder_push !== "boolean"))
    return c.json({ error: "nothing to update" }, 400);
  const userId = c.get("userId");
  const cur = await c.env.DB.prepare("SELECT daily_review_push, todo_reminder_push FROM user_preferences WHERE user_id = ?")
    .bind(userId)
    .first<{ daily_review_push: number; todo_reminder_push: number }>();
  const next = {
    daily_review_push: body.daily_review_push ?? (cur ? cur.daily_review_push === 1 : true),
    todo_reminder_push: body.todo_reminder_push ?? (cur ? cur.todo_reminder_push === 1 : true),
  };
  await c.env.DB.prepare(
    `INSERT INTO user_preferences (user_id, daily_review_push, todo_reminder_push, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (user_id) DO UPDATE SET daily_review_push = excluded.daily_review_push,
       todo_reminder_push = excluded.todo_reminder_push, updated_at = excluded.updated_at`
  )
    .bind(userId, next.daily_review_push ? 1 : 0, next.todo_reminder_push ? 1 : 0)
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
// 当天（上海时区）到期 + 已过期的未完成待办，供 bridge 上午推送清单
app.get("/api/todos/today", async (c) => {
  const today = shanghaiDate();
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND is_sensitive = 0 AND deleted_at IS NULL
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
  const which = (body?.which ?? body?.week) === "this" ? "this" : "last";
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
        return c.json({ error: "该来源不支持 zip 文件，请选择 Notion / Obsidian / Apple 备忘录来源上传 zip" }, 400);
      }
      text = new TextDecoder().decode(bytes);
    }
  } else {
    const body = await c.req.json<{ source?: unknown; content?: unknown }>().catch(() => null);
    source = typeof body?.source === "string" ? body.source : "";
    if (isZipSource(source)) return c.json({ error: "该来源需以 multipart 表单上传 zip 文件" }, 400);
    text = typeof body?.content === "string" ? body.content : "";
    if (text.length > MAX_IMPORT_BYTES) return c.json({ error: "内容过大：最大支持 20MB" }, 413);
  }
  if (!IMPORT_SOURCES.includes(source as ImportSource)) {
    return c.json({ error: "source 需为 cubox / flomo / markdown / text / notion / obsidian / apple-notes 之一" }, 400);
  }

  let items: ImportItem[];
  let parseFailures: ImportFailure[] = [];
  if (zipBytes) {
    const parsed = parseImportZip(source as ZipImportSource, zipBytes);
    items = parsed.items;
    parseFailures = parsed.failures;
  } else {
    if (!text.trim()) return c.json({ error: "文件内容为空" }, 400);
    items = parseImportFile(source as ImportSource, text);
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
        await writeLine({ stats: result.stats, failed_items: [...parseFailures, ...result.failures] });
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
  return c.json({ ...result.stats, failed_items: [...parseFailures, ...result.failures] }, 201);
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
  // notes still waiting for AI triage may turn out sensitive: a default
  // (redacted) export skips them and reports the count
  const allNotes = notesR.results ?? [];
  const exportable = includeSensitive ? allNotes : allNotes.filter((n) => n.category !== null || n.is_sensitive);
  const pendingExcluded = allNotes.length - exportable.length;
  const notes = await Promise.all(
    exportable.map((n) =>
      n.is_sensitive && !includeSensitive
        ? Promise.resolve(
            noteToJson({ ...n, content: SENSITIVE_EXPORT_PLACEHOLDER, title: SENSITIVE_EXPORT_PLACEHOLDER, tags: "[]" })
          )
        : noteToJsonDecrypted(c.env, n)
    )
  );
  const threads = threadsR.results ?? [];
  const reports = reportsR.results ?? [];

  const format = c.req.query("format");
  if (format === "markdown" || format === "md") {
    let md = `# 碎念全量导出（${new Date().toISOString().slice(0, 10)}）\n\n共 ${notes.length} 条笔记、${threads.length} 条线索、${reports.length} 份周报。${pendingExcluded > 0 ? `另有 ${pendingExcluded} 条待分拣笔记未包含（分拣完成后重新导出即可）。` : ""}\n\n## 笔记\n`;
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
    ...(pendingExcluded > 0 ? { pending_excluded: pendingExcluded } : {}),
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
/** Wall-clock budget for the cron retriage sweep; must stay under the 10-min cron interval. */
export const RETRIAGE_TIME_BUDGET_MS = 8 * 60_000;

async function retriageOne(env: Env, row: { id: string; user_id: string; content: string; content_enc: string | null }): Promise<boolean> {
  // pre-encrypted pending notes store a placeholder: triage the plaintext
  let content = row.content;
  if (row.content_enc && env.SUINIAN_ENC_KEY) {
    const plain = await decryptContent(env.SUINIAN_ENC_KEY, row.content_enc);
    if (plain !== null) content = plain;
  }
  const topTags = await loadTopTags(env.DB, row.user_id).catch(() => [] as string[]);
  const triage = await triageNote(content, env, topTags);
  if (!triage) return false;
  await applyTriage(env, row.id, triage, content);
  const n = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(row.id).first<NoteRow>();
  if (n) {
    await extractGraph(env, n);
    await clusterNote(env, n).catch((err) => console.error("retriage: cluster failed", err));
    await upsertNoteEmbedding(env, n);
  }
  return true;
}

/**
 * Re-triage notes the AI failed to sort (category still NULL), oldest first.
 * Each round pulls `limit` notes and triages them with bounded concurrency;
 * with a time budget it keeps draining rounds until the backlog is empty, the
 * budget is spent, or the AI stops responding — so a 3000-note import is
 * sorted within hours instead of weeks.
 */
export async function retriageUnsorted(env: Env, limit = 10, timeBudgetMs = 0): Promise<void> {
  const started = Date.now();
  for (;;) {
    const { results } = await env.DB.prepare(
      "SELECT id, user_id, content, content_enc FROM notes WHERE category IS NULL AND deleted_at IS NULL AND created_at < datetime('now', '-2 minutes') ORDER BY created_at ASC LIMIT ?"
    )
      .bind(limit)
      .all<{ id: string; user_id: string; content: string; content_enc: string | null }>();
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
      // resume queued/stale async rebuild jobs (survives the request-side slice dying)
      ctx.waitUntil(resumeThreadJobs(env));
      // web push: todo due reminders (at most once per todo) + daily review push (once per user per local day)
      ctx.waitUntil(sweepTodoReminders(env));
      ctx.waitUntil(sweepDailyReviewPush(env));
    } else {
      // daily thread title/summary refresh + daily review generation
      ctx.waitUntil(refreshThreads(env));
      ctx.waitUntil(generateAllDailyReviews(env));
    }
  },
};
