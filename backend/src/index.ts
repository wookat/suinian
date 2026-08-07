import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, NoteMeta, NoteRow, ThreadRow, TriageResult, WeeklyReportRow } from "./types";
import { triageNote, loadTopTags, normalizeTodoDue, FALLBACK_TRIAGE } from "./triage";
import { extractUrl, extractUrls, fetchLinkMeta } from "./linkmeta";
import { encryptContent, decryptContent, ENC_PLACEHOLDER } from "./crypto";
import { encodeCursor, decodeCursor } from "./cursor";
import { enrichLinkInto, backfillLinkExtracts } from "./extract";
import { clusterNote, refreshThreads, rebuildThreads } from "./threads";
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
import { generateWeeklyReport, generateAllWeeklyReports } from "./reports";
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

type Vars = { userId: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("*", cors());

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
  if (!(await checkRateLimit(c.env.DB, "register", clientIp(c.req.raw)))) {
    return c.json({ error: "操作过于频繁，请一分钟后再试" }, 429);
  }
  const body = await c.req.json<{ name?: unknown; password?: unknown }>().catch(() => null);
  const name = validateName(body?.name);
  if (!name) return c.json({ error: "用户名需 2-32 个字符（中英文、数字、._-）" }, 400);
  const password = validatePassword(body?.password);
  if (!password) return c.json({ error: "密码需 8-128 个字符" }, 400);
  const existing = await c.env.DB.prepare("SELECT id FROM users WHERE name = ?").bind(name).first<{ id: string }>();
  if (existing) return c.json({ error: "用户名已存在" }, 409);
  const id = `u_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const token = generateToken();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare("INSERT INTO users (id, name, api_token, password_hash) VALUES (?, ?, ?, ?)")
    .bind(id, name, token, passwordHash)
    .run();
  return c.json({ user: { id, name }, api_token: token }, 201);
});

app.post("/api/auth/login", async (c) => {
  if (!(await checkRateLimit(c.env.DB, "login", clientIp(c.req.raw)))) {
    return c.json({ error: "操作过于频繁，请一分钟后再试" }, 429);
  }
  const body = await c.req.json<{ name?: unknown; password?: unknown }>().catch(() => null);
  const name = validateName(body?.name);
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
  await next();
});

// ---- authenticated auth endpoints ----
app.get("/api/auth/me", async (c) => {
  const user = await c.env.DB.prepare("SELECT id, name, created_at, password_hash FROM users WHERE id = ?")
    .bind(c.get("userId"))
    .first<{ id: string; name: string; created_at: string; password_hash: string | null }>();
  if (!user) return c.json({ error: "not found" }, 404);
  return c.json({ user: { id: user.id, name: user.name, created_at: user.created_at, has_password: !!user.password_hash } });
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
  await c.env.DB.prepare("DELETE FROM attachments WHERE note_id IN (SELECT id FROM notes WHERE user_id = ?)").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM note_embeddings WHERE note_id IN (SELECT id FROM notes WHERE user_id = ?)").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM notes WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM threads WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM weekly_reports WHERE user_id = ?").bind(userId).run();
  await c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
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
};

async function applyTriage(env: Env, noteId: string, triage: TriageResult, content: string): Promise<void> {
  const sets = ["category = ?", "tags = ?", "title = ?", "is_sensitive = ?", "todo_due = ?"];
  const binds: unknown[] = [
    triage.category,
    JSON.stringify(triage.tags),
    triage.title || null,
    triage.is_sensitive ? 1 : 0,
    triage.todo_due ?? null,
  ];
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

async function createNote(
  c: { env: Env },
  userId: string,
  body: { source?: string; raw_type?: string; content?: string; url?: string; meta?: NoteMeta | null },
  waitUntil: (p: Promise<unknown>) => void,
  opts: { syncTriage: boolean }
): Promise<{ note: NoteRow; triage: TriageResult | null }> {
  const id = crypto.randomUUID();
  const content = (body.content ?? "").trim();
  const url = body.url || extractUrl(content);
  const urls = body.url && !content.includes(body.url) ? [body.url, ...extractUrls(content, 2)] : extractUrls(content, 3);
  const source = body.source || "api";
  const rawType = body.raw_type || (url && content === url ? "link" : "text");

  // insert immediately (category resolved by triage, sync or async)
  await c.env.DB.prepare(
    `INSERT INTO notes (id, user_id, source, raw_type, content, url, category, tags, meta)
     VALUES (?, ?, ?, ?, ?, ?, NULL, '[]', ?)`
  )
    .bind(id, userId, source, rawType, content, url ?? null, body.meta ? JSON.stringify(body.meta) : null)
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
  if (urls.length > 0) waitUntil(fetchLinkMetaInto(c.env, id, urls));

  let triage: TriageResult | null = null;
  if (opts.syncTriage) {
    triage = await runTriage();
    waitUntil(
      (async () => {
        const n = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
        if (n) await clusterNote(c.env, n);
        if (url) await enrichLinkInto(c.env, id);
      })()
    );
  } else {
    waitUntil(
      (async () => {
        await runTriage();
        const n = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
        if (n) await clusterNote(c.env, n);
        if (url) await enrichLinkInto(c.env, id);
      })()
    );
  }

  const note = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
  return { note: note!, triage };
}

// ---- POST /api/notes ----
app.post("/api/notes", async (c) => {
  const body = await c.req.json<{ source?: string; raw_type?: string; content?: string; url?: string }>().catch(() => null);
  if (!body || !(body.content ?? "").trim()) return c.json({ error: "content required" }, 400);
  const tooLong = contentTooLong(c, body.content ?? "");
  if (tooLong) return tooLong;
  // returns immediately; triage + link fetch + clustering backfill asynchronously
  const { note } = await createNote(c, c.get("userId"), body, (p) => c.executionCtx.waitUntil(p), { syncTriage: false });
  return c.json({ note: noteToJson(note) }, 201);
});

// ---- GET /api/notes ----
app.get("/api/notes", async (c) => {
  const userId = c.get("userId");
  const { category, tag, q, cursor } = c.req.query();
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10) || 20, 100);

  const conds: string[] = ["user_id = ?"];
  const binds: unknown[] = [userId];
  if (category) {
    conds.push("category = ?");
    binds.push(category);
  }
  if (tag) {
    conds.push("tags LIKE ?");
    binds.push(`%"${tag}"%`);
  }
  if (q) {
    conds.push("(content LIKE ? OR title LIKE ? OR url_title LIKE ? OR url_summary LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
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
  const notes = await Promise.all(page.map((n) => noteToJsonDecrypted(c.env, n)));
  return c.json({ notes, next_cursor: next });
});

// ---- PATCH /api/notes/:id ----
app.patch("/api/notes/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid body" }, 400);

  const existing = await c.env.DB.prepare("SELECT is_sensitive FROM notes WHERE id = ? AND user_id = ?")
    .bind(id, userId)
    .first<{ is_sensitive: number }>();
  if (!existing) return c.json({ error: "not found" }, 404);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof body.content === "string") {
    const tooLong = contentTooLong(c, body.content);
    if (tooLong) return tooLong;
    if (existing.is_sensitive && c.env.SUINIAN_ENC_KEY) {
      sets.push("content = ?", "content_enc = ?");
      binds.push(ENC_PLACEHOLDER, await encryptContent(c.env.SUINIAN_ENC_KEY, body.content));
    } else {
      sets.push("content = ?");
      binds.push(body.content);
    }
  }
  if (typeof body.todo_done === "boolean") {
    sets.push("todo_done = ?");
    binds.push(body.todo_done ? 1 : 0);
  }
  if (typeof body.category === "string" && ["idea", "todo", "collect", "data"].includes(body.category)) {
    sets.push("category = ?");
    binds.push(body.category);
  }
  if (Array.isArray(body.tags)) {
    sets.push("tags = ?");
    binds.push(JSON.stringify(body.tags.filter((t) => typeof t === "string")));
  }
  if (typeof body.title === "string") {
    sets.push("title = ?");
    binds.push(body.title);
  }
  if (typeof body.todo_due === "string" || body.todo_due === null) {
    sets.push("todo_due = ?");
    binds.push(normalizeTodoDue(body.todo_due));
  }
  if (sets.length === 0) return c.json({ error: "no updatable fields" }, 400);
  sets.push("updated_at = datetime('now')");

  const res = await c.env.DB.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...binds, id, userId)
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  const note = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
  return c.json({ note: await noteToJsonDecrypted(c.env, note!) });
});

// ---- DELETE /api/notes/:id ----
app.delete("/api/notes/:id", async (c) => {
  const id = c.req.param("id");
  const note = await c.env.DB.prepare("SELECT thread_id FROM notes WHERE id = ? AND user_id = ?")
    .bind(id, c.get("userId"))
    .first<{ thread_id: string | null }>();
  if (!note) return c.json({ error: "not found" }, 404);
  const atts = await c.env.DB.prepare("SELECT r2_key FROM attachments WHERE note_id = ?")
    .bind(id)
    .all<{ r2_key: string }>();
  await c.env.DB.prepare("DELETE FROM attachments WHERE note_id = ?").bind(id).run();
  if (c.env.MEDIA && atts.results.length > 0) {
    c.executionCtx.waitUntil(
      c.env.MEDIA.delete(atts.results.map((a) => a.r2_key)).catch((e) =>
        console.error("r2 delete failed", e)
      )
    );
  }
  await c.env.DB.prepare("DELETE FROM note_embeddings WHERE note_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  if (note.thread_id) {
    await c.env.DB.prepare(
      "UPDATE threads SET note_count = (SELECT COUNT(*) FROM notes WHERE thread_id = ?), updated_at = datetime('now') WHERE id = ?"
    )
      .bind(note.thread_id, note.thread_id)
      .run();
    await c.env.DB.prepare("DELETE FROM threads WHERE id = ? AND note_count = 0").bind(note.thread_id).run();
  }
  return c.json({ ok: true });
});

// ---- POST /api/ingest/wechat ----
app.post("/api/ingest/wechat", async (c) => {
  const body = await c.req.json<{ content?: string; url?: string; raw_type?: string }>().catch(() => null);
  if (!body || !(body.content ?? "").trim()) return c.json({ error: "content required" }, 400);
  const tooLong = contentTooLong(c, body.content ?? "");
  if (tooLong) return tooLong;
  // wechat needs the category/tags in its confirmation text -> triage stays synchronous
  const { note, triage: triageResult } = await createNote(
    c,
    c.get("userId"),
    { ...body, source: "wechat" },
    (p) => c.executionCtx.waitUntil(p),
    { syncTriage: true }
  );
  const triage = triageResult ?? FALLBACK_TRIAGE;
  const label = CATEGORY_LABEL[triage.category] ?? triage.category;
  const tagStr = triage.tags.map((t) => `#${t}`).join(" ");
  const reply = `已存 · ${label}${tagStr ? " " + tagStr : ""}`;
  return c.json({ note: await noteToJsonDecrypted(c.env, note), reply }, 201);
});

// ---- POST /api/ingest/media ----
// audio -> Whisper transcription, image -> vision text extraction; the extracted
// text becomes the note content and flows through the normal async triage pipeline.
app.post("/api/ingest/media", async (c) => {
  const parsed = await parseMediaRequest(c.req.raw);
  if ("error" in parsed) return c.json({ error: parsed.error }, parsed.status);

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

// ---- POST /api/ask ----
app.post("/api/ask", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ question?: string; history?: unknown }>().catch(() => null);
  const question = (body?.question ?? "").trim();
  if (!question) return c.json({ error: "question required" }, 400);
  const history = sanitizeAskHistory(body?.history);

  // keyword recall: current question + recent context terms, LIKE-match, top 20 recent.
  const terms = extractAskTerms(question, history);
  const conds: string[] = ["user_id = ?"];
  const binds: unknown[] = [userId];
  if (terms.length > 0) {
    const ors = terms.map(() => "(content LIKE ? OR title LIKE ? OR tags LIKE ? OR url_title LIKE ?)");
    conds.push(`(${ors.join(" OR ")})`);
    for (const t of terms) {
      const like = `%${t}%`;
      binds.push(like, like, like, like);
    }
  }
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM notes WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT 20`
  )
    .bind(...binds)
    .all<NoteRow>();
  let notes = results ?? [];
  if (notes.length === 0) {
    // keyword recall missed (common for CJK questions): fall back to recent notes
    const recent = await c.env.DB.prepare(
      "SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 20"
    )
      .bind(userId)
      .all<NoteRow>();
    notes = recent.results ?? [];
  }

  const noteIds = notes.map((n) => n.id);
  const context = notes
    .map((n, i) => `[${i + 1}] (id=${n.id}, ${n.created_at}, ${n.category ?? ""}) ${n.title ?? ""}\n${n.content.slice(0, 500)}`)
    .join("\n\n");
  const answer = await chatComplete(c.env, {
    temperature: 0.3,
    max_tokens: 800,
    timeout_ms: 40_000,
    messages: [
      {
        role: "system",
        content:
          "你是「碎念」个人笔记问答助手。根据下面用户的笔记片段回答问题，引用时用 [序号] 标注。可结合之前的对话上下文理解代词与省略。若笔记中没有相关信息，直接说没找到。回答用中文，简洁。",
      },
      ...history,
      { role: "user", content: `笔记片段：\n${context || "（无相关笔记）"}\n\n问题：${question}` },
    ],
  });
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
app.get("/api/threads", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM threads WHERE user_id = ? AND note_count > 0 ORDER BY updated_at DESC LIMIT 100"
  )
    .bind(c.get("userId"))
    .all<ThreadRow>();
  return c.json({ threads: results ?? [] });
});

// ---- POST /api/threads/rebuild ----
app.post("/api/threads/rebuild", async (c) => {
  const result = await rebuildThreads(c.env, c.get("userId"));
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM threads WHERE user_id = ? AND note_count > 0 ORDER BY updated_at DESC LIMIT 100"
  )
    .bind(c.get("userId"))
    .all<ThreadRow>();
  return c.json({ ...result, threads: results ?? [] });
});

// ---- GET /api/threads/:id ----
app.get("/api/threads/:id", async (c) => {
  const userId = c.get("userId");
  const thread = await c.env.DB.prepare("SELECT * FROM threads WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), userId)
    .first<ThreadRow>();
  if (!thread) return c.json({ error: "not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM notes WHERE thread_id = ? AND user_id = ? ORDER BY created_at ASC LIMIT 200"
  )
    .bind(thread.id, userId)
    .all<NoteRow>();
  const notes = await Promise.all((results ?? []).map((n) => noteToJsonDecrypted(c.env, n)));
  return c.json({ thread, notes });
});

// ---- GET /api/reports ----
app.get("/api/reports", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, week_start, created_at FROM weekly_reports WHERE user_id = ? ORDER BY week_start DESC LIMIT 100"
  )
    .bind(c.get("userId"))
    .all<{ id: string; week_start: string; created_at: string }>();
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
  const body = await c.req.json<{ week?: string }>().catch(() => null);
  const week = body?.week === "this" ? "this" : "last";
  const { id, week_start } = await generateWeeklyReport(c.env, c.get("userId"), new Date(), week);
  const report = await c.env.DB.prepare("SELECT * FROM weekly_reports WHERE id = ?").bind(id).first<WeeklyReportRow>();
  return c.json({ report, week_start }, 201);
});

// ---- GET /api/export ----
app.get("/api/export", async (c) => {
  const userId = c.get("userId");
  const [notesR, threadsR, reportsR] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM notes WHERE user_id = ? ORDER BY created_at ASC").bind(userId).all<NoteRow>(),
    c.env.DB.prepare("SELECT * FROM threads WHERE user_id = ? ORDER BY updated_at DESC").bind(userId).all<ThreadRow>(),
    c.env.DB.prepare("SELECT * FROM weekly_reports WHERE user_id = ? ORDER BY week_start DESC").bind(userId).all<WeeklyReportRow>(),
  ]);
  const notes = await Promise.all((notesR.results ?? []).map((n) => noteToJsonDecrypted(c.env, n)));
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

export { app };

/** Re-triage notes the AI failed to sort (category still NULL), oldest first. */
export async function retriageUnsorted(env: Env, limit = 10): Promise<void> {
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, content FROM notes WHERE category IS NULL AND created_at < datetime('now', '-2 minutes') ORDER BY created_at ASC LIMIT ?"
  )
    .bind(limit)
    .all<{ id: string; user_id: string; content: string }>();
  for (const row of results ?? []) {
    const topTags = await loadTopTags(env.DB, row.user_id).catch(() => [] as string[]);
    const triage = await triageNote(row.content, env, topTags);
    if (!triage) continue;
    await applyTriage(env, row.id, triage, row.content);
    const n = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(row.id).first<NoteRow>();
    if (n) await clusterNote(env, n).catch((err) => console.error("retriage: cluster failed", err));
  }
}

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "0 0 * * 1") {
      // Monday 08:00 Asia/Shanghai = Monday 00:00 UTC -> weekly reports
      ctx.waitUntil(generateAllWeeklyReports(env));
    } else if (event.cron === "*/10 * * * *") {
      // sweep notes whose async triage failed or was cancelled
      ctx.waitUntil(retriageUnsorted(env));
      // backfill article extraction for link notes (a few per run, rate-limited)
      ctx.waitUntil(backfillLinkExtracts(env));
    } else {
      // daily thread title/summary refresh
      ctx.waitUntil(refreshThreads(env));
    }
  },
};
