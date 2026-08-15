import { describe, it, expect } from "vitest";
import { app, applyTriage } from "../src/index";
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

// Minimal stateful fake D1 (same shape as r36-edit.test.ts).
function fakeDb(notes: Row[]) {
  const matchNotes = (sql: string, binds: unknown[]): Row[] => {
    if (sql.includes("WHERE id = ? AND user_id = ?"))
      return notes.filter((n) => n.id === binds[0] && n.user_id === binds[1] && !n.deleted_at);
    if (sql.includes("WHERE id = ?")) return notes.filter((n) => n.id === binds[0]);
    if (sql.includes("WHERE user_id = ?")) return notes.filter((n) => n.user_id === binds[0]);
    return notes;
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
            const whereBinds = binds.slice(cols.length) as string[];
            let targets = notes.filter(
              (n) => n.id === whereBinds[0] && (!wherePart.includes("user_id = ?") || n.user_id === whereBinds[1])
            );
            if (wherePart.includes("updated_at = ?"))
              targets = targets.filter((n) => n.updated_at === whereBinds[whereBinds.length - 1]);
            for (const note of targets) {
              cols.forEach((col, i) => (note[col] = binds[i]));
              nowCols.forEach((col) => (note[col] = "2026-08-07 00:00:01"));
            }
            return { meta: { changes: targets.length } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
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

const triageNoDue: TriageResult = {
  category: "collect",
  tags: ["ai-tag"],
  title: "AI 标题",
  is_sensitive: false,
  todo_due: null,
  amount: null,
  currency: null,
  merchant: null,
};

describe("PATCH records manual_override for todo_due/title", () => {
  it("hand-set todo_due marks manual_override.todo_due", async () => {
    const notes = [baseNote("n1", { category: "todo" })];
    const res = await app.request(
      req("PATCH", "/api/notes/n1", { todo_due: "2026-08-09T14:00:00+08:00" }),
      undefined,
      makeEnv(notes),
      ctx
    );
    expect(res.status).toBe(200);
    expect(notes[0].todo_due).toBe("2026-08-09T14:00:00+08:00");
    const meta = JSON.parse(notes[0].meta as string) as { manual_override: Record<string, boolean> };
    expect(meta.manual_override.todo_due).toBe(true);
  });

  it("hand-set title marks manual_override.title", async () => {
    const notes = [baseNote("n1")];
    await app.request(req("PATCH", "/api/notes/n1", { title: "手动标题" }), undefined, makeEnv(notes), ctx);
    const meta = JSON.parse(notes[0].meta as string) as { manual_override: Record<string, boolean> };
    expect(meta.manual_override.title).toBe(true);
  });

  it("clearing todo_due by hand also marks manual_override.todo_due", async () => {
    const notes = [baseNote("n1", { category: "todo", todo_due: "2026-08-09" })];
    await app.request(req("PATCH", "/api/notes/n1", { todo_due: null }), undefined, makeEnv(notes), ctx);
    expect(notes[0].todo_due).toBeNull();
    const meta = JSON.parse(notes[0].meta as string) as { manual_override: Record<string, boolean> };
    expect(meta.manual_override.todo_due).toBe(true);
  });
});

describe("applyTriage never clobbers hand-set fields (manual edit -> async triage race)", () => {
  it("keeps a manually-set todo_due when triage returns todo_due=null", async () => {
    const notes = [
      baseNote("n1", {
        category: "todo",
        todo_due: "2026-08-09T14:00:00+08:00",
        meta: JSON.stringify({ manual_override: { category: true, todo_due: true } }),
      }),
    ];
    await applyTriage(makeEnv(notes), "n1", triageNoDue, "note n1");
    expect(notes[0].todo_due).toBe("2026-08-09T14:00:00+08:00");
    expect(notes[0].category).toBe("todo");
  });

  it("keeps a manually-cleared todo_due when triage suggests one", async () => {
    const notes = [
      baseNote("n1", { meta: JSON.stringify({ manual_override: { todo_due: true } }) }),
    ];
    await applyTriage(makeEnv(notes), "n1", { ...triageNoDue, todo_due: "2026-08-10" }, "note n1");
    expect(notes[0].todo_due).toBeNull();
  });

  it("keeps a manually-set title when triage returns an AI title", async () => {
    const notes = [
      baseNote("n1", { title: "手动标题", meta: JSON.stringify({ manual_override: { title: true } }) }),
    ];
    await applyTriage(makeEnv(notes), "n1", triageNoDue, "note n1");
    expect(notes[0].title).toBe("手动标题");
  });

  it("without override, an existing todo_due is never cleared by a null triage due", async () => {
    const notes = [baseNote("n1", { category: "todo", todo_due: "2026-08-09" })];
    await applyTriage(makeEnv(notes), "n1", triageNoDue, "note n1");
    expect(notes[0].todo_due).toBe("2026-08-09");
  });

  it("without override and no existing due, triage fills the due", async () => {
    const notes = [baseNote("n1", { category: null })];
    await applyTriage(makeEnv(notes), "n1", { ...triageNoDue, category: "todo", todo_due: "2026-08-10" }, "note n1");
    expect(notes[0].todo_due).toBe("2026-08-10");
    expect(notes[0].title).toBe("AI 标题");
  });

  it("full race: manual due set via PATCH, then triage completes -> due preserved", async () => {
    const notes = [baseNote("n1", { category: null })];
    const env = makeEnv(notes);
    await app.request(
      req("PATCH", "/api/notes/n1", { category: "todo", todo_due: "2026-08-09T14:00:00+08:00" }),
      undefined,
      env,
      ctx
    );
    await applyTriage(env, "n1", triageNoDue, "note n1");
    expect(notes[0].category).toBe("todo");
    expect(notes[0].todo_due).toBe("2026-08-09T14:00:00+08:00");
  });
});
