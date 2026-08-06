import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env, NoteRow, TriageResult } from "./types";
import { triageNote, FALLBACK_TRIAGE } from "./triage";
import { extractUrl, fetchLinkMeta } from "./linkmeta";
import { encodeCursor, decodeCursor } from "./cursor";

type Vars = { userId: string };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("*", cors());

app.get("/", (c) => c.json({ name: "suinian-api", status: "ok" }));
app.get("/health", (c) => c.json({ ok: true }));

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

function noteToJson(n: NoteRow) {
  return { ...n, tags: JSON.parse(n.tags || "[]") as string[], is_sensitive: !!n.is_sensitive, todo_done: !!n.todo_done };
}

const CATEGORY_LABEL: Record<string, string> = {
  idea: "想法",
  todo: "待办",
  collect: "收藏",
  data: "资料",
};

async function createNote(
  c: { env: Env },
  userId: string,
  body: { source?: string; raw_type?: string; content?: string; url?: string },
  waitUntil: (p: Promise<unknown>) => void
): Promise<{ note: NoteRow; triage: TriageResult }> {
  const id = crypto.randomUUID();
  const content = (body.content ?? "").trim();
  const url = body.url || extractUrl(content);
  const source = body.source || "api";
  const rawType = body.raw_type || (url && content === url ? "link" : "text");

  // AI triage (synchronous so the caller can reply with category/tags; falls back fast)
  let triage = FALLBACK_TRIAGE;
  if (c.env.DEEPSEEK_API_KEY) {
    triage = await triageNote(content, c.env);
  }

  await c.env.DB.prepare(
    `INSERT INTO notes (id, user_id, source, raw_type, content, url, category, tags, title, is_sensitive, todo_due)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      userId,
      source,
      rawType,
      content,
      url ?? null,
      triage.category,
      JSON.stringify(triage.tags),
      triage.title || null,
      triage.is_sensitive ? 1 : 0,
      triage.todo_due ?? null
    )
    .run();

  // link metadata in background
  if (url) {
    waitUntil(
      (async () => {
        const meta = await fetchLinkMeta(url);
        if (meta.title || meta.description) {
          await c.env.DB.prepare(
            "UPDATE notes SET url_title = ?, url_summary = ?, updated_at = datetime('now') WHERE id = ?"
          )
            .bind(meta.title, meta.description, id)
            .run();
        }
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
  const { note } = await createNote(c, c.get("userId"), body, (p) => c.executionCtx.waitUntil(p));
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
  return c.json({ notes: page.map(noteToJson), next_cursor: next });
});

// ---- PATCH /api/notes/:id ----
app.patch("/api/notes/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "invalid body" }, 400);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (typeof body.content === "string") {
    sets.push("content = ?");
    binds.push(body.content);
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
    binds.push(body.todo_due);
  }
  if (sets.length === 0) return c.json({ error: "no updatable fields" }, 400);
  sets.push("updated_at = datetime('now')");

  const res = await c.env.DB.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`)
    .bind(...binds, id, userId)
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  const note = await c.env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first<NoteRow>();
  return c.json({ note: noteToJson(note!) });
});

// ---- DELETE /api/notes/:id ----
app.delete("/api/notes/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!res.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

// ---- POST /api/ingest/wechat ----
app.post("/api/ingest/wechat", async (c) => {
  const body = await c.req.json<{ content?: string; url?: string; raw_type?: string }>().catch(() => null);
  if (!body || !(body.content ?? "").trim()) return c.json({ error: "content required" }, 400);
  const { note, triage } = await createNote(
    c,
    c.get("userId"),
    { ...body, source: "wechat" },
    (p) => c.executionCtx.waitUntil(p)
  );
  const label = CATEGORY_LABEL[triage.category] ?? triage.category;
  const tagStr = triage.tags.map((t) => `#${t}`).join(" ");
  const reply = `已存 · ${label}${tagStr ? " " + tagStr : ""}`;
  return c.json({ note: noteToJson(note), reply }, 201);
});

// ---- POST /api/ask ----
app.post("/api/ask", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ question?: string }>().catch(() => null);
  const question = (body?.question ?? "").trim();
  if (!question) return c.json({ error: "question required" }, 400);

  // keyword recall: split question into terms, LIKE-match, top 20 recent
  const terms = question
    .split(/[\s,，。？?！!、;；:：]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6);
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

  if (!c.env.DEEPSEEK_API_KEY) {
    return c.json({ answer: "（AI 暂不可用）已找到相关记录，见 references。", references: notes.map((n) => n.id) });
  }

  const context = notes
    .map((n, i) => `[${i + 1}] (id=${n.id}, ${n.created_at}, ${n.category ?? ""}) ${n.title ?? ""}\n${n.content.slice(0, 500)}`)
    .join("\n\n");
  try {
    const res = await fetch(`${c.env.DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${c.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.3,
        max_tokens: 800,
        messages: [
          {
            role: "system",
            content:
              "你是「碎念」个人笔记问答助手。根据下面用户的笔记片段回答问题，引用时用 [序号] 标注。若笔记中没有相关信息，直接说没找到。回答用中文，简洁。",
          },
          { role: "user", content: `笔记片段：\n${context || "（无相关笔记）"}\n\n问题：${question}` },
        ],
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const answer = data.choices?.[0]?.message?.content ?? "";
    return c.json({ answer, references: notes.map((n) => n.id) });
  } catch {
    return c.json({ answer: "（AI 暂不可用）已找到相关记录，见 references。", references: notes.map((n) => n.id) });
  }
});

export default app;
