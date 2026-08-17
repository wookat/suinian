import { describe, it, expect } from "vitest";
import { app, applyTriage } from "../src/index";
import { parseTriageJson } from "../src/triage";
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

// Minimal stateful fake D1 covering the batch route's SQL (see r36-edit.test.ts).
function fakeDb(notes: Row[]) {
  const matchNotes = (sql: string, binds: unknown[]): Row[] => {
    const deletedFilter = (rows: Row[]): Row[] => {
      if (sql.includes("deleted_at IS NULL")) return rows.filter((n) => !n.deleted_at);
      return rows;
    };
    if (sql.includes("id IN (")) {
      const ids = binds.slice(1) as string[];
      return deletedFilter(notes.filter((n) => n.user_id === binds[0] && ids.includes(n.id as string)));
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
          if (sql.includes("auth_rate_limits")) return { count: 1 };
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
            let targets: Row[];
            if (wherePart.includes("id IN (")) {
              const ids = whereBinds.slice(1);
              targets = notes.filter((n) => n.user_id === whereBinds[0] && ids.includes(n.id as string));
            } else {
              targets = notes.filter(
                (n) => n.id === whereBinds[0] && (!wherePart.includes("user_id = ?") || n.user_id === whereBinds[1])
              );
            }
            if (wherePart.includes("deleted_at IS NULL")) targets = targets.filter((n) => !n.deleted_at);
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

// ---- D-1: 批量改分类可撤销 ----

describe("batch set_category returns prev snapshots (R172 D-1)", () => {
  it("echoes each note's previous category and manual flag", async () => {
    const notes = [
      baseNote("n1", { category: "idea" }),
      baseNote("n2", { category: "todo", meta: JSON.stringify({ manual_override: { category: true } }) }),
      baseNote("n3", { category: null }),
    ];
    const res = await app.request(
      req("POST", "/api/notes/batch", { action: "set_category", ids: ["n1", "n2", "n3"], category: "data" }),
      undefined,
      makeEnv(notes),
      ctx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected: number; ids: string[]; prev: { id: string; category: string | null; manual: boolean }[] };
    expect(body.affected).toBe(3);
    expect(body.ids).toEqual(["n1", "n2", "n3"]);
    expect(body.prev).toEqual([
      { id: "n1", category: "idea", manual: false },
      { id: "n2", category: "todo", manual: true },
      { id: "n3", category: null, manual: false },
    ]);
    expect(notes.every((n) => n.category === "data")).toBe(true);
  });

  it("streams prev in the final NDJSON line", async () => {
    const notes = [baseNote("n1", { category: "idea" })];
    const res = await app.request(
      req("POST", "/api/notes/batch?stream=1", { action: "set_category", ids: ["n1"], category: "collect" }),
      undefined,
      makeEnv(notes),
      ctx
    );
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = lines[lines.length - 1] as { ok: boolean; prev: unknown[] };
    expect(last.ok).toBe(true);
    expect(last.prev).toEqual([{ id: "n1", category: "idea", manual: false }]);
  });
});

describe("batch restore_categories (R172 D-1 undo)", () => {
  it("restores previous categories and manual_override bits", async () => {
    const notes = [
      baseNote("n1", { category: "data", meta: JSON.stringify({ manual_override: { category: true } }) }),
      baseNote("n2", { category: "data", meta: JSON.stringify({ manual_override: { category: true, tags: true } }) }),
    ];
    const res = await app.request(
      req("POST", "/api/notes/batch", {
        action: "restore_categories",
        entries: [
          { id: "n1", category: "idea", manual: false },
          { id: "n2", category: "todo", manual: true },
        ],
      }),
      undefined,
      makeEnv(notes),
      ctx
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected: number; ids: string[] };
    expect(body.affected).toBe(2);
    expect(notes[0].category).toBe("idea");
    expect(notes[1].category).toBe("todo");
    const meta1 = JSON.parse(notes[0].meta as string) as { manual_override?: { category?: boolean } };
    const meta2 = JSON.parse(notes[1].meta as string) as { manual_override?: { category?: boolean; tags?: boolean } };
    expect(meta1.manual_override?.category).toBeUndefined();
    expect(meta2.manual_override?.category).toBe(true);
    expect(meta2.manual_override?.tags).toBe(true);
  });

  it("restores a null category (pre-triage note)", async () => {
    const notes = [baseNote("n1", { category: "data", meta: JSON.stringify({ manual_override: { category: true } }) })];
    const res = await app.request(
      req("POST", "/api/notes/batch", {
        action: "restore_categories",
        entries: [{ id: "n1", category: null, manual: false }],
      }),
      undefined,
      makeEnv(notes),
      ctx
    );
    expect(res.status).toBe(200);
    expect(notes[0].category).toBeNull();
  });

  it("rejects empty or invalid entries", async () => {
    const env = makeEnv([baseNote("n1")]);
    expect(
      (await app.request(req("POST", "/api/notes/batch", { action: "restore_categories", entries: [] }), undefined, env, ctx)).status
    ).toBe(400);
    expect(
      (
        await app.request(
          req("POST", "/api/notes/batch", { action: "restore_categories", entries: [{ id: "n1", category: "nonsense", manual: false }] }),
          undefined,
          env,
          ctx
        )
      ).status
    ).toBe(400);
  });

  it("skips other users' notes", async () => {
    const notes = [baseNote("n1", { user_id: "u2", category: "data" })];
    const res = await app.request(
      req("POST", "/api/notes/batch", {
        action: "restore_categories",
        entries: [{ id: "n1", category: "idea", manual: false }],
      }),
      undefined,
      makeEnv(notes),
      ctx
    );
    const body = (await res.json()) as { affected: number };
    expect(body.affected).toBe(0);
    expect(notes[0].category).toBe("data");
  });
});

// ---- D-2: 无问号疑问句 is_question ----

describe("triage is_question (R172 D-2)", () => {
  it("parseTriageJson surfaces is_question=true and defaults to false", () => {
    const q = parseTriageJson(
      `{"category":"idea","tags":[],"title":"","is_sensitive":false,"todo_due":null,"amount":null,"currency":null,"is_question":true}`
    );
    expect(q?.is_question).toBe(true);
    const plain = parseTriageJson(
      `{"category":"idea","tags":[],"title":"","is_sensitive":false,"todo_due":null,"amount":null,"currency":null}`
    );
    expect(plain?.is_question).toBe(false);
    const junk = parseTriageJson(
      `{"category":"idea","tags":[],"title":"","is_sensitive":false,"todo_due":null,"amount":null,"currency":null,"is_question":"yes"}`
    );
    expect(junk?.is_question).toBe(false);
  });

  const triage = (over: Partial<TriageResult> = {}): TriageResult => ({
    category: "idea",
    tags: [],
    title: "t",
    is_sensitive: false,
    todo_due: null,
    ...over,
  });

  it("applyTriage persists meta.is_question and clears it on re-triage", async () => {
    const notes = [baseNote("n1", { category: null })];
    const env = makeEnv(notes);
    await applyTriage(env, "n1", triage({ is_question: true }), "note n1");
    let meta = JSON.parse(notes[0].meta as string) as { is_question?: boolean };
    expect(meta.is_question).toBe(true);
    await applyTriage(env, "n1", triage({ is_question: false }), "note n1");
    meta = JSON.parse(notes[0].meta as string) as { is_question?: boolean };
    expect(meta.is_question).toBeUndefined();
  });

  it("applyTriage suppresses is_question for sensitive notes", async () => {
    const notes = [baseNote("n1", { category: null })];
    await applyTriage(makeEnv(notes), "n1", triage({ is_question: true, is_sensitive: true }), "note n1");
    const meta = JSON.parse((notes[0].meta as string) ?? "{}") as { is_question?: boolean };
    expect(meta.is_question).toBeUndefined();
  });
});
