import { describe, it, expect } from "vitest";
import { app, applyTriage } from "../src/index";
import { todoSection, type TodoStats } from "../src/reports";
import type { Env, TriageResult } from "../src/types";

type Row = Record<string, unknown>;

function baseNote(id: string, over: Row = {}): Row {
  return {
    id,
    user_id: "u1",
    source: "api",
    raw_type: "text",
    category: "idea",
    tags: "[]",
    title: null,
    url: null,
    url_title: null,
    url_summary: null,
    url_titles: null,
    meta: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: 0,
    done_at: null,
    thread_id: null,
    content: `note ${id}`,
    content_enc: null,
    created_at: "2026-08-07 00:00:00",
    updated_at: "2026-08-07 00:00:00",
    deleted_at: null,
    ...over,
  };
}

// Multi-note stateful fake D1: enough SQL coverage for PATCH / batch / tags routes.
function fakeDb(notes: Row[]) {
  const matchNotes = (sql: string, binds: unknown[]): Row[] => {
    const deletedFilter = (rows: Row[]): Row[] => {
      if (sql.includes("deleted_at IS NULL")) return rows.filter((n) => !n.deleted_at);
      if (sql.includes("deleted_at IS NOT NULL")) return rows.filter((n) => !!n.deleted_at);
      return rows;
    };
    if (sql.includes("id IN (")) {
      const ids = binds.slice(1) as string[];
      return deletedFilter(notes.filter((n) => n.user_id === binds[0] && ids.includes(n.id as string)));
    }
    if (sql.includes("tags LIKE")) {
      const like = String(binds[1]).replace(/%/g, "");
      return deletedFilter(notes.filter((n) => n.user_id === binds[0] && String(n.tags).includes(like)));
    }
    if (sql.includes("WHERE id = ? AND user_id = ?"))
      return deletedFilter(notes.filter((n) => n.id === binds[0] && n.user_id === binds[1]));
    if (sql.includes("WHERE id = ?")) return deletedFilter(notes.filter((n) => n.id === binds[0]));
    if (sql.includes("WHERE user_id = ?")) return deletedFilter(notes.filter((n) => n.user_id === binds[0]));
    return deletedFilter(notes);
  };
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM users")) return binds[0] === "good-token" ? { id: "u1" } : null;
          if (sql.includes("FROM notes")) return matchNotes(sql, binds)[0] ?? null;
          return null;
        },
        async all() {
          if (sql.includes("FROM notes")) return { results: matchNotes(sql, binds).map((n) => ({ ...n })) };
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET")) {
            const whereIdx = sql.indexOf(" WHERE ");
            const setPart = sql.slice(0, whereIdx);
            const wherePart = sql.slice(whereIdx);
            const cols = [...setPart.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            const nowCols = [...setPart.matchAll(/(\w+) = datetime\('now'\)/g)].map((m) => m[1]);
            const nullCols = [...setPart.matchAll(/(\w+) = NULL/g)].map((m) => m[1]);
            const whereBinds = binds.slice(cols.length) as string[];
            let targets: Row[];
            if (wherePart.includes("id IN (")) {
              const ids = whereBinds.slice(1);
              targets = notes.filter((n) => n.user_id === whereBinds[0] && ids.includes(n.id as string));
            } else {
              targets = notes.filter(
                (n) => n.id === whereBinds[0] && (whereBinds.length < 2 || n.user_id === whereBinds[1])
              );
            }
            if (wherePart.includes("deleted_at IS NULL")) targets = targets.filter((n) => !n.deleted_at);
            if (wherePart.includes("deleted_at IS NOT NULL")) targets = targets.filter((n) => !!n.deleted_at);
            for (const note of targets) {
              cols.forEach((col, i) => (note[col] = binds[i]));
              nowCols.forEach((col) => (note[col] = "2026-08-07 00:00:01"));
              nullCols.forEach((col) => (note[col] = null));
            }
            return { meta: { changes: targets.length } };
          }
          if (sql.startsWith("DELETE FROM notes")) {
            const before = notes.length;
            const idx = notes.findIndex((n) => n.id === binds[0]);
            if (idx >= 0) notes.splice(idx, 1);
            return { meta: { changes: before - notes.length } };
          }
          if (sql.startsWith("UPDATE users")) return { meta: { changes: 1 } };
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
}

function makeEnv(notes: Row[]): Env {
  return {
    DB: fakeDb(notes),
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  } as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function req(method: string, path: string, body?: Record<string, unknown>) {
  return new Request(`http://x${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer good-token" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("PATCH manual_override + done_at", () => {
  it("hand-set category/tags record manual_override in meta", async () => {
    const notes = [baseNote("n1")];
    const res = await app.request(
      req("PATCH", "/api/notes/n1", { category: "todo", tags: ["工作"] }),
      undefined,
      makeEnv(notes),
      ctx
    );
    expect(res.status).toBe(200);
    expect(notes[0].category).toBe("todo");
    expect(notes[0].tags).toBe('["工作"]');
    const meta = JSON.parse(notes[0].meta as string) as { manual_override: Record<string, boolean> };
    expect(meta.manual_override).toEqual({ category: true, tags: true });
  });

  it("todo_done toggling sets and clears done_at", async () => {
    const notes = [baseNote("n1", { category: "todo" })];
    const env = makeEnv(notes);
    await app.request(req("PATCH", "/api/notes/n1", { todo_done: true }), undefined, env, ctx);
    expect(notes[0].todo_done).toBe(1);
    expect(typeof notes[0].done_at).toBe("string");
    await app.request(req("PATCH", "/api/notes/n1", { todo_done: false }), undefined, env, ctx);
    expect(notes[0].todo_done).toBe(0);
    expect(notes[0].done_at).toBeNull();
  });
});

describe("applyTriage respects manual_override", () => {
  const triage: TriageResult = {
    category: "collect",
    tags: ["ai-tag"],
    title: "t",
    is_sensitive: false,
    todo_due: null,
  };

  it("skips overridden category/tags but still applies the rest", async () => {
    const notes = [
      baseNote("n1", {
        category: "todo",
        tags: '["手动"]',
        meta: JSON.stringify({ manual_override: { category: true, tags: true } }),
      }),
    ];
    await applyTriage(makeEnv(notes), "n1", triage, "x");
    expect(notes[0].category).toBe("todo");
    expect(notes[0].tags).toBe('["手动"]');
    expect(notes[0].title).toBe("t");
  });

  it("applies category/tags without override", async () => {
    const notes = [baseNote("n1", { category: null })];
    await applyTriage(makeEnv(notes), "n1", triage, "x");
    expect(notes[0].category).toBe("collect");
    expect(notes[0].tags).toBe('["ai-tag"]');
  });
});

describe("POST /api/notes/batch", () => {
  it("add_tags unions tags and marks manual_override", async () => {
    const notes = [baseNote("n1", { tags: '["a"]' }), baseNote("n2")];
    const res = await app.request(
      req("POST", "/api/notes/batch", { action: "add_tags", ids: ["n1", "n2"], tags: ["a", "b"] }),
      undefined,
      makeEnv(notes),
      ctx
    );
    const body = (await res.json()) as { affected: number };
    expect(res.status).toBe(200);
    expect(body.affected).toBe(2);
    expect(JSON.parse(notes[0].tags as string)).toEqual(["a", "b"]);
    expect(JSON.parse(notes[1].tags as string)).toEqual(["a", "b"]);
    expect((JSON.parse(notes[0].meta as string) as { manual_override: { tags: boolean } }).manual_override.tags).toBe(true);
  });

  it("set_category updates all ids", async () => {
    const notes = [baseNote("n1"), baseNote("n2")];
    const res = await app.request(
      req("POST", "/api/notes/batch", { action: "set_category", ids: ["n1", "n2"], category: "data" }),
      undefined,
      makeEnv(notes),
      ctx
    );
    expect(res.status).toBe(200);
    expect(notes[0].category).toBe("data");
    expect(notes[1].category).toBe("data");
  });

  it("delete soft-deletes only owned notes", async () => {
    const notes = [baseNote("n1"), baseNote("n2", { user_id: "u2" })];
    const res = await app.request(
      req("POST", "/api/notes/batch", { action: "delete", ids: ["n1", "n2"] }),
      undefined,
      makeEnv(notes),
      ctx
    );
    const body = (await res.json()) as { affected: number };
    expect(body.affected).toBe(1);
    expect(notes[0].deleted_at).toBeTruthy();
    expect(notes[1].deleted_at).toBeNull();
  });

  it("delete with stream=1 emits NDJSON progress and final affected", async () => {
    const notes = [baseNote("n1"), baseNote("n2")];
    const res = await app.request(
      req("POST", "/api/notes/batch?stream=1", { action: "delete", ids: ["n1", "n2"] }),
      undefined,
      makeEnv(notes),
      ctx
    );
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toEqual({ done: 0, total: 2 });
    expect(lines[lines.length - 1]).toEqual({ ok: true, affected: 2 });
  });

  it("restore clears deleted_at for owned notes only", async () => {
    const notes = [
      baseNote("n1", { deleted_at: "2026-08-07 00:00:00" }),
      baseNote("n2", { user_id: "u2", deleted_at: "2026-08-07 00:00:00" }),
    ];
    const res = await app.request(
      req("POST", "/api/notes/restore", { ids: ["n1", "n2"] }),
      undefined,
      makeEnv(notes),
      ctx
    );
    const body = (await res.json()) as { restored: number };
    expect(res.status).toBe(200);
    expect(body.restored).toBe(1);
    expect(notes[0].deleted_at).toBeNull();
    expect(notes[1].deleted_at).toBeTruthy();
  });

  it("rejects invalid action and empty ids", async () => {
    const env = makeEnv([baseNote("n1")]);
    expect((await app.request(req("POST", "/api/notes/batch", { action: "nope", ids: ["n1"] }), undefined, env, ctx)).status).toBe(400);
    expect((await app.request(req("POST", "/api/notes/batch", { action: "delete", ids: [] }), undefined, env, ctx)).status).toBe(400);
  });
});

describe("tag management", () => {
  it("GET /api/tags aggregates counts", async () => {
    const notes = [baseNote("n1", { tags: '["a","b"]' }), baseNote("n2", { tags: '["a"]' })];
    const res = await app.request(req("GET", "/api/tags"), undefined, makeEnv(notes), ctx);
    const body = (await res.json()) as { tags: { tag: string; count: number }[] };
    expect(body.tags).toEqual([
      { tag: "a", count: 2 },
      { tag: "b", count: 1 },
    ]);
  });

  it("rename replaces globally and merges duplicates", async () => {
    const notes = [baseNote("n1", { tags: '["old","keep"]' }), baseNote("n2", { tags: '["old","new"]' })];
    const res = await app.request(
      req("POST", "/api/tags/rename", { from: "old", to: "new" }),
      undefined,
      makeEnv(notes),
      ctx
    );
    const body = (await res.json()) as { affected: number };
    expect(body.affected).toBe(2);
    expect(JSON.parse(notes[0].tags as string)).toEqual(["new", "keep"]);
    expect(JSON.parse(notes[1].tags as string)).toEqual(["new"]);
  });

  it("rename does not touch substring-matched tags", async () => {
    const notes = [baseNote("n1", { tags: '["ab"]' })];
    await app.request(req("POST", "/api/tags/rename", { from: "a", to: "z" }), undefined, makeEnv(notes), ctx);
    expect(JSON.parse(notes[0].tags as string)).toEqual(["ab"]);
  });

  it("delete removes the tag from all notes", async () => {
    const notes = [baseNote("n1", { tags: '["a","b"]' }), baseNote("n2", { tags: '["a"]' })];
    const res = await app.request(req("POST", "/api/tags/delete", { tag: "a" }), undefined, makeEnv(notes), ctx);
    const body = (await res.json()) as { affected: number };
    expect(body.affected).toBe(2);
    expect(JSON.parse(notes[0].tags as string)).toEqual(["b"]);
    expect(JSON.parse(notes[1].tags as string)).toEqual([]);
  });
});

describe("weekly report todo section", () => {
  it("renders counts with done/open checklists", () => {
    const stats: TodoStats = {
      created: 3,
      createdDone: 1,
      doneInWeek: 2,
      openTitles: ["写周报"],
      doneTitles: ["修 bug", "回邮件"],
    };
    const md = todoSection(stats);
    expect(md).toContain("本周新增待办 3 条，共完成 2 条");
    expect(md).toContain("- [x] 修 bug");
    expect(md).toContain("- [ ] 写周报");
  });
});
