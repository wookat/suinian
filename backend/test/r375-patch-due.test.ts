import { describe, it, expect } from "vitest";
import { app } from "../src/index";
import { normalizeTodoDue } from "../src/triage";
import type { Env } from "../src/types";

type Row = Record<string, unknown>;

function baseNote(id: string): Row {
  return {
    id,
    user_id: "u1",
    content: "交季度总结",
    title: "",
    category: "todo",
    tags: "[]",
    is_sensitive: 0,
    todo_due: null,
    todo_done: 0,
    done_at: null,
    amount: null,
    currency: null,
    merchant: null,
    meta: null,
    raw_type: "text",
    source: "web",
    url: null,
    created_at: "2026-08-07 00:00:00",
    updated_at: "2026-08-07 00:00:00",
    deleted_at: null,
  };
}

function fakeDb(notes: Row[], tz: string | null) {
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
          if (sql.includes("FROM user_preferences")) return { tz };
          if (sql.includes("FROM notes")) return notes.find((n) => n.id === binds[0] && !n.deleted_at) ?? null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET")) {
            const setPart = sql.slice(0, sql.indexOf(" WHERE "));
            const cols = [...setPart.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            const whereBinds = binds.slice(cols.length) as string[];
            const targets = notes.filter((n) => n.id === whereBinds[0]);
            for (const note of targets) cols.forEach((col, i) => (note[col] = binds[i]));
            return { meta: { changes: targets.length } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function makeEnv(notes: Row[], tz: string | null): Env {
  return { DB: fakeDb(notes, tz), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" } as Env;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function patchDueRes(tz: string | null, todo_due: string | null, initial: string | null = null) {
  const notes = [baseNote("n1")];
  notes[0].todo_due = initial;
  const res = await app.request(
    new Request("http://localhost/api/notes/n1", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: "Bearer good-token" },
      body: JSON.stringify({ todo_due }),
    }),
    undefined,
    makeEnv(notes, tz),
    ctx
  );
  return { res, notes };
}

async function patchDue(tz: string | null, todo_due: string | null): Promise<unknown> {
  const { res, notes } = await patchDueRes(tz, todo_due);
  expect(res.status).toBe(200);
  return notes[0].todo_due;
}

describe("PATCH todo_due: bare local time takes the user's timezone", () => {
  it("uses the user_preferences tz for bare times (America/New_York in September = -04:00)", async () => {
    expect(await patchDue("America/New_York", "2026-09-10 18:00")).toBe("2026-09-10T18:00:00-04:00");
    expect(await patchDue("America/New_York", "2026-09-10T18:00:00")).toBe("2026-09-10T18:00:00-04:00");
  });

  it("falls back to +08:00 when the user has no tz preference", async () => {
    expect(await patchDue(null, "2026-09-10 18:00")).toBe("2026-09-10T18:00:00+08:00");
  });

  it("keeps an explicit offset / Z and date-only values untouched", async () => {
    expect(await patchDue("America/New_York", "2026-09-10T18:00:00+09:00")).toBe("2026-09-10T18:00:00+09:00");
    expect(await patchDue("America/New_York", "2026-09-10T18:00:00Z")).toBe("2026-09-10T18:00:00+00:00");
    expect(await patchDue("America/New_York", "2026-09-10")).toBe("2026-09-10");
    expect(await patchDue("America/New_York", null)).toBeNull();
  });
});

describe("PATCH todo_due: unparseable non-empty strings are rejected, not silently cleared", () => {
  it("returns 400 and leaves the stored due untouched", async () => {
    for (const bad of ["明天下午", "2026/09/12 18:00", "9月12日 18:00", "2026-9-12 18:00", "2026-09-12 6pm"]) {
      const { res, notes } = await patchDueRes("Asia/Shanghai", bad, "2026-09-12T18:00:00+08:00");
      expect(res.status, bad).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("到期时间格式不支持");
      expect(notes[0].todo_due).toBe("2026-09-12T18:00:00+08:00");
      expect(notes[0].meta).toBeNull();
    }
  });

  it("empty / whitespace-only string still clears the due (same as null)", async () => {
    for (const empty of ["", "   "]) {
      const { res, notes } = await patchDueRes("Asia/Shanghai", empty, "2026-09-12T18:00:00+08:00");
      expect(res.status).toBe(200);
      expect(notes[0].todo_due).toBeNull();
    }
  });

  it("surrounding whitespace around a valid value is tolerated", async () => {
    expect(await patchDue(null, " 2026-09-12 18:00 ")).toBe("2026-09-12T18:00:00+08:00");
  });
});

describe("normalizeTodoDue strict mode", () => {
  it("rejects trailing garbage that the lenient parser would truncate", () => {
    expect(normalizeTodoDue("2026-09-12 6pm")).toBe("2026-09-12");
    expect(normalizeTodoDue("2026-09-12 6pm", "+08:00", true)).toBeNull();
    expect(normalizeTodoDue("2026-09-12 18:00", "+08:00", true)).toBe("2026-09-12T18:00:00+08:00");
    expect(normalizeTodoDue(" 2026-09-12T18:00:00Z ", "+08:00", true)).toBe("2026-09-12T18:00:00+00:00");
    expect(normalizeTodoDue("2026-09-12", "+08:00", true)).toBe("2026-09-12");
  });
});
