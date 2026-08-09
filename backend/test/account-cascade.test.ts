import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deleteUserData, USER_ID_TABLES, NOTE_ID_TABLES } from "../src/account";
import type { Env } from "../src/types";

const MIGRATIONS_DIR = new URL("../migrations", import.meta.url).pathname;

function tablesMatching(bodyPattern: RegExp): string[] {
  const found = new Set<string>();
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
    // walk CREATE TABLE blocks; a table is affected if any column matches
    const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      if (bodyPattern.test(m[2])) found.add(m[1]);
    }
  }
  return [...found].sort();
}
const tablesWithForeignKey = tablesMatching;

describe("user deletion cascade coverage", () => {
  it("USER_ID_TABLES covers every migration table referencing users(id)", () => {
    const expected = tablesWithForeignKey(/REFERENCES\s+users\s*\(\s*id\s*\)/);
    expect([...USER_ID_TABLES].sort()).toEqual(expected);
  });

  // the R77 P1: 0015 declared user_id columns WITHOUT `REFERENCES users(id)`,
  // slipping past the check above. Any user_id column in any migration must be
  // in the cascade list, references clause or not.
  it("USER_ID_TABLES covers every migration table with a user_id column", () => {
    const withUserIdColumn = tablesMatching(/(?:^|[(,\n])\s*user_id\s+/);
    for (const t of withUserIdColumn) {
      expect(USER_ID_TABLES, `table ${t} has a user_id column but is missing from USER_ID_TABLES`).toContain(t);
    }
  });

  it("every table referencing notes(id) is cleaned by the cascade, before notes", () => {
    const noteTables = tablesWithForeignKey(/REFERENCES\s+notes\s*\(\s*id\s*\)/);
    const notesIdx = USER_ID_TABLES.indexOf("notes");
    for (const t of noteTables) {
      const userIdx = (USER_ID_TABLES as readonly string[]).indexOf(t);
      const inNoteList = (NOTE_ID_TABLES as readonly string[]).includes(t);
      // must be covered, and if deleted via the user_id list it must come
      // before notes or the FK constraint fires (the R49 daily_reviews 500)
      expect(inNoteList || userIdx >= 0).toBe(true);
      if (userIdx >= 0) expect(userIdx).toBeLessThan(notesIdx);
    }
  });
});

// Stateful fake D1: rows per table keyed by user_id / note_id
function fakeDb(rows: Record<string, { user_id?: string; note_id?: string; id?: string }[]>) {
  const db = {
    rows,
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async run() {
          const noteScoped = sql.match(/^DELETE FROM (\w+) WHERE note_id IN \(SELECT id FROM notes WHERE user_id = \?\)$/);
          if (noteScoped) {
            const noteIds = new Set((rows.notes ?? []).filter((n) => n.user_id === binds[0]).map((n) => n.id));
            rows[noteScoped[1]] = (rows[noteScoped[1]] ?? []).filter((r) => !noteIds.has(r.note_id));
            return { meta: { changes: 1 } };
          }
          const userScoped = sql.match(/^DELETE FROM (\w+) WHERE user_id = \?$/);
          if (userScoped) {
            if (userScoped[1] === "notes") {
              // emulate SQLite FK enforcement: deleting a note still referenced
              // by a note_id child row must fail (production D1 behavior)
              const doomed = new Set((rows.notes ?? []).filter((n) => n.user_id === binds[0]).map((n) => n.id));
              for (const [table, tableRows] of Object.entries(rows)) {
                if (table === "notes") continue;
                for (const r of tableRows) {
                  if (r.note_id && doomed.has(r.note_id)) {
                    throw new Error(`FOREIGN KEY constraint failed: ${table}.note_id -> notes.id`);
                  }
                }
              }
            }
            rows[userScoped[1]] = (rows[userScoped[1]] ?? []).filter((r) => r.user_id !== binds[0]);
            return { meta: { changes: 1 } };
          }
          if (sql === "DELETE FROM users WHERE id = ?") {
            rows.users = (rows.users ?? []).filter((r) => r.id !== binds[0]);
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
  return db;
}

describe("deleteUserData", () => {
  it("removes every row of the user (and only that user) across all tables", async () => {
    const rows: Record<string, { user_id?: string; note_id?: string; id?: string }[]> = {
      users: [{ id: "u1" }, { id: "u2" }],
      notes: [
        { id: "n1", user_id: "u1" },
        { id: "n2", user_id: "u2" },
      ],
      attachments: [
        { id: "a1", note_id: "n1" },
        { id: "a2", note_id: "n2" },
      ],
      note_embeddings: [{ note_id: "n1" }, { note_id: "n2" }],
      threads: [{ id: "t1", user_id: "u1" }],
      weekly_reports: [{ id: "w1", user_id: "u1" }],
      entities: [{ id: "e1", user_id: "u1" }],
      edges: [{ id: "g1", user_id: "u1" }],
      daily_reviews: [{ id: "d1", user_id: "u1", note_id: "n1" }],
      user_preferences: [{ user_id: "u1" }, { user_id: "u2" }],
      thread_jobs: [{ id: "j1", user_id: "u1" }, { id: "j2", user_id: "u2" }],
      thread_backfill: [{ user_id: "u1" }, { user_id: "u2" }],
    };
    const db = fakeDb(rows);
    await deleteUserData({ DB: db as unknown as D1Database } as Env, "u1");
    expect(rows.users).toEqual([{ id: "u2" }]);
    expect(rows.notes).toEqual([{ id: "n2", user_id: "u2" }]);
    expect(rows.attachments).toEqual([{ id: "a2", note_id: "n2" }]);
    expect(rows.note_embeddings).toEqual([{ note_id: "n2" }]);
    expect(rows.threads).toEqual([]);
    expect(rows.weekly_reports).toEqual([]);
    expect(rows.entities).toEqual([]);
    expect(rows.edges).toEqual([]);
    expect(rows.daily_reviews).toEqual([]);
    // note: d1 referenced n1 via note_id — the fake enforces the FK, so this
    // passing proves daily_reviews is cleared before notes
    expect(rows.user_preferences).toEqual([{ user_id: "u2" }]);
    expect(rows.thread_jobs).toEqual([{ id: "j2", user_id: "u2" }]);
    expect(rows.thread_backfill).toEqual([{ user_id: "u2" }]);
  });
});
