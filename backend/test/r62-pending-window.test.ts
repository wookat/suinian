// R62: the pre-triage window must never serve plaintext that is about to be
// judged sensitive — write-time regex pre-encryption + pending-note exclusion
// in backup/export + pending redaction in MCP outputs.
import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { app, retriageUnsorted } from "../src/index";
import { buildBackupZip, type BackupManifest, type BackupNote } from "../src/backup";
import { redactPendingNote, MCP_PENDING_PLACEHOLDER, MCP_SENSITIVE_PLACEHOLDER, redactNote } from "../src/mcp";
import { encryptContent, decryptContent, ENC_PLACEHOLDER } from "../src/crypto";
import type { Env } from "../src/types";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));
const SECRET_CONTENT = "服务器 root 密码是 P@ssw0rd123";
const PLAIN_CONTENT = "今天想到一个产品点子";

type Row = Record<string, unknown>;

const BASE_NOTE: Row = {
  id: "n1",
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
  amount: null,
  currency: null,
  thread_id: null,
  content: "普通笔记",
  content_enc: null,
  created_at: "2026-08-07 00:00:00",
  updated_at: "2026-08-07 00:00:00",
};

/** Stateful fake D1: token auth, INSERT/UPDATE applied onto in-memory rows. */
function fakeDb(rows: Row[]) {
  return {
    rows,
    async batch() {
      return [];
    },
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM users")) return binds[0] === "good-token" ? { id: "u1" } : null;
          if (sql.includes("FROM notes WHERE id = ?")) return rows.find((r) => r.id === binds[0]) ?? null;
          return null;
        },
        async all() {
          if (sql.includes("category IS NULL")) return { results: rows.filter((r) => r.category === null) };
          if (sql.includes("FROM notes")) return { results: rows };
          return { results: [] };
        },
        async run() {
          if (sql.includes("INSERT INTO notes")) {
            rows.push({
              ...BASE_NOTE,
              id: binds[0],
              user_id: binds[1],
              source: binds[2],
              raw_type: binds[3],
              content: binds[4],
              url: binds[5],
              category: binds[6],
              tags: binds[7],
              meta: binds[8],
              is_sensitive: binds[9],
              content_enc: binds[10],
            });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE notes SET")) {
            const setClause = sql.slice(0, sql.indexOf(" WHERE "));
            const cols = [...setClause.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            const row = rows.find((r) => r.id === binds[cols.length]);
            if (row) cols.forEach((col, i) => (row[col] = binds[i]));
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database & { rows: Row[] };
}

function makeCtx() {
  const tasks: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => tasks.push(p.catch(() => undefined)),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    tasks,
  };
}

async function postNote(db: D1Database, content: string) {
  const { ctx } = makeCtx();
  const env = { DB: db, SUINIAN_ENC_KEY: KEY, AI_MODEL: "mock" };
  const res = await app.request(
    new Request("http://local/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer good-token" },
      body: JSON.stringify({ content, source: "api" }),
    }),
    undefined,
    env,
    ctx
  );
  return res;
}

describe("write-time sensitive pre-encryption (regex, no AI)", () => {
  it("stores obvious credential values encrypted from the first write", async () => {
    const db = fakeDb([]);
    const res = await postNote(db, SECRET_CONTENT);
    expect(res.status).toBe(201);
    const stored = db.rows[0];
    expect(stored.is_sensitive).toBe(1);
    expect(stored.content).toBe(ENC_PLACEHOLDER);
    expect(typeof stored.content_enc).toBe("string");
    expect(await decryptContent(KEY, stored.content_enc as string)).toBe(SECRET_CONTENT);
    // the owner's own echo still shows the plaintext
    const body = (await res.json()) as { note: { content: string; is_sensitive: boolean } };
    expect(body.note.content).toBe(SECRET_CONTENT);
    expect(body.note.is_sensitive).toBe(true);
  });

  it("leaves normal content as plaintext", async () => {
    const db = fakeDb([]);
    const res = await postNote(db, PLAIN_CONTENT);
    expect(res.status).toBe(201);
    const stored = db.rows[0];
    expect(stored.is_sensitive).toBe(0);
    expect(stored.content).toBe(PLAIN_CONTENT);
    expect(stored.content_enc).toBeNull();
  });
});

describe("retriage sweep decrypts pre-encrypted pending notes", () => {
  it("triages the plaintext, not the placeholder, and keeps it encrypted", async () => {
    const enc = await encryptContent(KEY, SECRET_CONTENT);
    const db = fakeDb([
      { ...BASE_NOTE, id: "p1", category: null, content: ENC_PLACEHOLDER, content_enc: enc, is_sensitive: 1 },
    ]);
    const env = { DB: db, SUINIAN_ENC_KEY: KEY, AI_MODEL: "mock" } as unknown as Env;
    await retriageUnsorted(env);
    const row = db.rows[0];
    // regex fallback on the decrypted plaintext keeps it sensitive; the
    // placeholder alone would have come back non-sensitive
    expect(row.is_sensitive).toBe(1);
    expect(row.content).toBe(ENC_PLACEHOLDER);
    expect(await decryptContent(KEY, row.content_enc as string)).toBe(SECRET_CONTENT);
    expect(row.category).not.toBeNull();
  });
});

// ---- backup: pending notes always included (R106); sensitive redaction intact ----

function backupEnv(rows: Row[]): Env {
  return { DB: fakeDb(rows), SUINIAN_ENC_KEY: KEY } as unknown as Env;
}

async function runBackup(rows: Row[], includeSensitive: boolean) {
  const tasks: Promise<unknown>[] = [];
  const res = await buildBackupZip(backupEnv(rows), "u1", includeSensitive, (p) => tasks.push(p));
  await Promise.all(tasks);
  const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
  return {
    manifest: JSON.parse(strFromU8(zip["manifest.json"])) as BackupManifest,
    notes: JSON.parse(strFromU8(zip["notes.json"])) as BackupNote[],
  };
}

describe("backup includes pending (unsorted) notes", () => {
  const PENDING = { ...BASE_NOTE, id: "p1", category: null, content: "还没分拣的普通笔记" };
  const PENDING_SENSITIVE = {
    ...BASE_NOTE,
    id: "p2",
    category: null,
    content: ENC_PLACEHOLDER,
    content_enc: null as string | null,
    is_sensitive: 1,
  };
  const SORTED = { ...BASE_NOTE, id: "s1", content: "已分拣的普通笔记" };

  it("default backup includes pending notes with category null", async () => {
    const enc = await encryptContent(KEY, SECRET_CONTENT);
    const { manifest, notes } = await runBackup([PENDING, { ...PENDING_SENSITIVE, content_enc: enc }, SORTED], false);
    expect(notes.map((n) => n.id)).toEqual(["p1", "p2", "s1"]);
    expect(notes[0].category).toBeNull();
    expect(notes[0].content).toBe(PENDING.content);
    // pre-encrypted pending note stays redacted in a default backup
    expect(JSON.stringify(notes)).not.toContain(SECRET_CONTENT);
    expect(manifest.counts.notes).toBe(3);
    expect("pending_excluded" in manifest).toBe(false);
  });

  it("include_sensitive backup decrypts the pre-encrypted pending note", async () => {
    const enc = await encryptContent(KEY, SECRET_CONTENT);
    const { notes } = await runBackup([PENDING, { ...PENDING_SENSITIVE, content_enc: enc }, SORTED], true);
    expect(notes.map((n) => n.id)).toEqual(["p1", "p2", "s1"]);
    expect(notes[1].content).toBe(SECRET_CONTENT);
  });
});

// ---- export: same pending policy as backup ----

describe("/api/export includes pending notes", () => {
  const PENDING = { ...BASE_NOTE, id: "p1", category: null, content: "还没分拣的普通笔记" };
  const SORTED = { ...BASE_NOTE, id: "s1", content: "已分拣的普通笔记" };

  async function runExport(query: string) {
    const env = { DB: fakeDb([PENDING, SORTED]), SUINIAN_ENC_KEY: KEY };
    return app.request(
      new Request(`http://local/api/export${query}`, {
        headers: { authorization: "Bearer good-token" },
      }),
      undefined,
      env,
      makeCtx().ctx
    );
  }

  it("default export includes pending notes with category null", async () => {
    const res = await runExport("");
    const body = (await res.json()) as { notes: { id: string; category: string | null }[]; pending_excluded?: number };
    expect(body.notes.map((n) => n.id)).toEqual(["p1", "s1"]);
    expect(body.notes[0].category).toBeNull();
    expect(body.pending_excluded).toBeUndefined();
  });

  it("include_sensitive=true export contains pending notes", async () => {
    const res = await runExport("?include_sensitive=true");
    const body = (await res.json()) as { notes: { id: string }[]; pending_excluded?: number };
    expect(body.notes.map((n) => n.id)).toEqual(["p1", "s1"]);
    expect(body.pending_excluded).toBeUndefined();
  });

  it("markdown export renders pending notes under 未分拣", async () => {
    const res = await runExport("?format=md");
    const md = await res.text();
    expect(md).toContain("共 2 条笔记");
    expect(md).toContain("未分拣");
    expect(md).not.toContain("待分拣笔记未包含");
  });
});

// ---- MCP: pending notes redacted in list/search outputs ----

describe("MCP pending redaction", () => {
  it("withholds content of unsorted notes", () => {
    const note = { id: "p1", is_sensitive: false, category: null, content: SECRET_CONTENT, title: "t", tags: ["a"] };
    const out = redactPendingNote(note);
    expect(out.content).toBe(MCP_PENDING_PLACEHOLDER);
    expect(out.title).toBe(MCP_PENDING_PLACEHOLDER);
    expect(out.tags).toEqual([]);
  });

  it("leaves sorted notes untouched and sensitive redaction intact", () => {
    const sorted = { id: "s1", is_sensitive: false, category: "idea", content: "ok", title: "t", tags: ["a"] };
    expect(redactPendingNote(sorted)).toEqual(sorted);
    const sensitive = { id: "x1", is_sensitive: true, category: "data", content: "秘密", title: "t", tags: ["a"] };
    expect(redactNote(sensitive).content).toBe(MCP_SENSITIVE_PLACEHOLDER);
  });
});
