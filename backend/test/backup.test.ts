import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";
import { buildBackupZip, restoreBackup, restoreFileName, restoreTodoDue, BACKUP_FORMAT, type BackupNote, type BackupManifest, type RestoreStats } from "../src/backup";
import { SENSITIVE_EXPORT_PLACEHOLDER } from "../src/constants";
import { encryptContent, decryptContent, ENC_PLACEHOLDER } from "../src/crypto";
import type { Env } from "../src/types";

const NOTE = {
  id: "n1",
  user_id: "u1",
  source: "wechat",
  raw_type: "text",
  content: "第一条碎念 #想法",
  url: null,
  url_title: null,
  url_summary: null,
  url_titles: null,
  category: "idea",
  tags: '["想法"]',
  title: "第一条",
  thread_id: "t1",
  is_sensitive: 0,
  content_enc: null,
  todo_due: null,
  todo_done: 0,
  done_at: null,
  amount: null,
  currency: null,
  meta: '{"graph_extracted_at":"2026-08-01T00:00:00Z","finance_merchant":"x"}',
  created_at: "2026-08-01 00:00:00",
  updated_at: "2026-08-01 00:00:00",
};

const SENSITIVE_NOTE = {
  ...NOTE,
  id: "n2",
  content: "服务器密码 abc",
  category: "data",
  tags: '["密码"]',
  title: "服务器 root 密码",
  thread_id: null,
  is_sensitive: 1,
  meta: null,
  created_at: "2026-08-02 00:00:00",
  updated_at: "2026-08-02 00:00:00",
};

const IMAGE_NOTE = {
  ...NOTE,
  id: "n3",
  raw_type: "image",
  content: "图片里的文字",
  category: "collect",
  tags: "[]",
  title: "图片",
  thread_id: null,
  meta: '{"file_name":"pic.png"}',
  created_at: "2026-08-03 00:00:00",
  updated_at: "2026-08-03 00:00:00",
};

const ATTACHMENT = { id: "a1", note_id: "n3", r2_key: "media/u1/n3/1757000000000-pic.png", mime: "image/png", size: 4 };
// R128 P1: sensitive note's original attachment (e.g. a txt holding a password)
const SENSITIVE_ATTACHMENT = { id: "a2", note_id: "n2", r2_key: "media/u1/n2/456-deploy.txt", mime: "text/plain", size: 5 };

interface Recorded {
  sql: string;
  binds: unknown[];
}

/** Fake D1: canned reads for backup, insert recording for restore. */
function fakeDb(opts: {
  notes?: Record<string, unknown>[];
  threads?: Record<string, unknown>[];
  attachments?: Record<string, unknown>[];
  existing?: { content: string; created_at: string }[];
  sensExisting?: { content: string; content_enc: string | null; created_at: string }[];
  inserted?: Recorded[];
}) {
  const inserted = opts.inserted ?? [];
  return {
    prepare(sql: string) {
      const make = (binds: unknown[]) => ({
        bind(...args: unknown[]) {
          return make(args);
        },
        async first() {
          return null;
        },
        async all() {
          if (sql.includes("FROM notes") && sql.includes("is_sensitive = 1")) return { results: opts.sensExisting ?? [] };
          if (sql.includes("FROM notes") && sql.includes("SELECT content")) return { results: opts.existing ?? [] };
          if (sql.includes("FROM notes")) return { results: opts.notes ?? [] };
          if (sql.includes("FROM threads")) return { results: opts.threads ?? [] };
          if (sql.includes("FROM weekly_reports")) return { results: [] };
          if (sql.includes("FROM attachments")) return { results: opts.attachments ?? [] };
          return { results: [] };
        },
        async run() {
          inserted.push({ sql, binds });
          return { meta: { changes: 1 } };
        },
        _sql: sql,
        _binds: binds,
      });
      return make([]);
    },
    async batch(stmts: { _sql: string; _binds: unknown[] }[]) {
      for (const s of stmts) inserted.push({ sql: s._sql, binds: s._binds });
      return [];
    },
  } as unknown as D1Database;
}

function fakeR2(store: Map<string, Uint8Array>) {
  return {
    async get(key: string) {
      const data = store.get(key);
      if (!data) return null;
      return {
        size: data.length,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        }),
        httpMetadata: { contentType: "image/png" },
      };
    },
    async put(key: string, value: Uint8Array) {
      store.set(key, value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer));
    },
  } as unknown as R2Bucket;
}

async function collectZip(env: Env, includeSensitive = false): Promise<Map<string, Uint8Array>> {
  const tasks: Promise<unknown>[] = [];
  const res = await buildBackupZip(env, "u1", includeSensitive, (p) => tasks.push(p));
  expect(res.headers.get("content-type")).toBe("application/zip");
  const buf = new Uint8Array(await res.arrayBuffer());
  await Promise.all(tasks);
  const entries = unzipSync(buf);
  return new Map(Object.entries(entries));
}

describe("buildBackupZip", () => {
  const media = new Map([
    [ATTACHMENT.r2_key, new Uint8Array([1, 2, 3, 4])],
    [SENSITIVE_ATTACHMENT.r2_key, strToU8("s3cr3t")],
  ]);
  const env = {
    DB: fakeDb({
      notes: [NOTE, SENSITIVE_NOTE, IMAGE_NOTE],
      threads: [{ id: "t1", user_id: "u1", title: "产品思考", summary: null, note_count: 1, updated_at: "2026-08-01 00:00:00" }],
      attachments: [ATTACHMENT, SENSITIVE_ATTACHMENT],
    }),
    MEDIA: fakeR2(media),
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  } as unknown as Env;

  it("packs manifest + notes.json (all fields) + media originals", async () => {
    const entries = await collectZip(env);
    const manifest = JSON.parse(strFromU8(entries.get("manifest.json")!)) as BackupManifest;
    expect(manifest.format).toBe(BACKUP_FORMAT);
    expect(manifest.counts).toEqual({ notes: 3, threads: 1, reports: 0, attachments: 1, attachments_redacted: 1 });

    const notes = JSON.parse(strFromU8(entries.get("notes.json")!)) as BackupNote[];
    expect(notes).toHaveLength(3);
    const n1 = notes.find((n) => n.id === "n1")!;
    expect(n1.tags).toEqual(["想法"]);
    expect(n1.category).toBe("idea");
    expect(n1.thread_title).toBe("产品思考");
    expect(n1.created_at).toBe("2026-08-01 00:00:00");

    // sensitive redacted by default: content, title and tags
    const n2 = notes.find((n) => n.id === "n2")!;
    expect(n2.content).toBe(SENSITIVE_EXPORT_PLACEHOLDER);
    expect(n2.title).toBe(SENSITIVE_EXPORT_PLACEHOLDER);
    expect(n2.tags).toEqual([]);
    expect(n2.is_sensitive).toBe(true);
    // R128 P1: sensitive attachment originals stay out of a redacted backup
    expect(n2.attachments).toEqual([]);
    for (const [name, data] of entries) {
      expect(name.startsWith("media/n2/")).toBe(false);
      if (name.endsWith(".json")) continue;
      expect(strFromU8(data)).not.toContain("s3cr3t");
    }

    // media original present, referenced from the note
    const n3 = notes.find((n) => n.id === "n3")!;
    expect(n3.attachments).toHaveLength(1);
    const path = n3.attachments[0].path;
    expect(path).toBe("media/n3/0-pic.png");
    // name is the bare file name (no zip index / R2 timestamp prefix)
    expect(n3.attachments[0].name).toBe("pic.png");
    expect(Array.from(entries.get(path)!)).toEqual([1, 2, 3, 4]);
  });

  it("includes sensitive plaintext only when asked", async () => {
    const entries = await collectZip(env, true);
    const notes = JSON.parse(strFromU8(entries.get("notes.json")!)) as BackupNote[];
    const n2 = notes.find((n) => n.id === "n2")!;
    expect(n2.content).toBe("服务器密码 abc");
    expect(n2.title).toBe("服务器 root 密码");
    expect(n2.tags).toEqual(["密码"]);
    // R128 P1: attachment originals ride along only with include_sensitive
    expect(n2.attachments).toHaveLength(1);
    const path = n2.attachments[0].path;
    expect(path.startsWith("media/n2/")).toBe(true);
    expect(strFromU8(entries.get(path)!)).toBe("s3cr3t");
    const manifest = JSON.parse(strFromU8(entries.get("manifest.json")!)) as BackupManifest;
    expect(manifest.counts.attachments).toBe(2);
    expect(manifest.counts.attachments_redacted).toBe(0);
  });
});

function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

describe("restoreBackup", () => {
  function makeBackupZip(notes: Partial<BackupNote>[], media: Record<string, Uint8Array> = {}): Uint8Array {
    return zipSync({
      "manifest.json": strToU8(JSON.stringify({ format: BACKUP_FORMAT, version: 1 })),
      "notes.json": strToU8(JSON.stringify(notes)),
      ...media,
    });
  }

  it("restores notes (time/tags/category kept), media into R2 + attachments", async () => {
    const inserted: Recorded[] = [];
    const store = new Map<string, Uint8Array>();
    const env = {
      DB: fakeDb({ inserted }),
      MEDIA: fakeR2(store),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const zip = makeBackupZip(
      [
        {
          id: "old1",
          source: "wechat",
          raw_type: "image",
          content: "图片里的文字",
          category: "collect",
          tags: ["照片"],
          title: "图片",
          is_sensitive: false,
          meta: { file_name: "pic.png", graph_extracted_at: "x" } as BackupNote["meta"],
          created_at: "2026-08-03 00:00:00",
          updated_at: "2026-08-03 00:00:00",
          attachments: [{ path: "media/old1/0-pic.png", name: "0-pic.png", mime: "image/png", size: 4 }],
        },
      ],
      { "media/old1/0-pic.png": new Uint8Array([9, 8, 7, 6]) }
    );
    const tasks: Promise<unknown>[] = [];
    const result = await restoreBackup(env, "u9", streamOf(zip), (p) => tasks.push(p));
    await Promise.all(tasks);
    expect(result).toMatchObject({ notes_total: 1, notes_imported: 1, notes_skipped: 0, media_imported: 1 });

    const noteInsert = inserted.find((r) => r.sql.includes("INSERT INTO notes"))!;
    expect(noteInsert.binds[1]).toBe("u9"); // user_id
    expect(noteInsert.binds[3]).toBe("image"); // raw_type
    expect(noteInsert.binds[4]).toBe("图片里的文字");
    expect(noteInsert.binds[9]).toBe("collect"); // category preserved
    expect(noteInsert.binds[10]).toBe('["照片"]'); // tags preserved
    expect(noteInsert.binds[20]).toBe("2026-08-03 00:00:00"); // created_at preserved
    // graph marker stripped so the cron re-extracts
    expect(String(noteInsert.binds[19])).not.toContain("graph_extracted_at");

    // media re-uploaded under the new note id and recorded in attachments
    expect(store.size).toBe(1);
    const key = [...store.keys()][0];
    expect(key.startsWith("media/u9/")).toBe(true);
    expect(Array.from(store.get(key)!)).toEqual([9, 8, 7, 6]);
    const attInsert = inserted.find((r) => r.sql.includes("INSERT INTO attachments"))!;
    expect(attInsert.binds[2]).toBe(key);
    // legacy backup (name == zip entry name): the `0-` index is not baked into the restored key
    expect(key.endsWith("-pic.png")).toBe(true);
    expect(key).not.toContain("-0-pic.png");
  });

  it("restores attachments under their original file name (no index prefix accumulating across generations)", async () => {
    const cases: [BackupNote["attachments"][number], string][] = [
      // current format: name is the bare file name, path carries the index
      [{ path: "media/old1/0-voice.ogg", name: "voice.ogg", mime: "audio/ogg", size: 1 }, "voice.ogg"],
      // file whose own name starts with digits-dash keeps it
      [{ path: "media/old1/0-2024-report.pdf", name: "2024-report.pdf", mime: "application/pdf", size: 1 }, "2024-report.pdf"],
      // legacy format: name == entry name → strip exactly one index prefix
      [{ path: "media/old1/0-2024-report.pdf", name: "0-2024-report.pdf", mime: "application/pdf", size: 1 }, "2024-report.pdf"],
      // legacy zip that already went through one buggy restore keeps the leftover `0-` (only one strip)
      [{ path: "media/old1/0-0-pic.png", name: "0-0-pic.png", mime: "image/png", size: 1 }, "0-pic.png"],
      // missing name falls back to the entry name minus index
      [{ path: "media/old1/3-note.txt", name: "", mime: "text/plain", size: 1 }, "note.txt"],
    ];
    for (const [att, expected] of cases) expect(restoreFileName(att)).toBe(expected);

    const inserted: Recorded[] = [];
    const store = new Map<string, Uint8Array>();
    const env = {
      DB: fakeDb({ inserted }),
      MEDIA: fakeR2(store),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const zip = makeBackupZip(
      [
        {
          id: "old1",
          source: "api",
          raw_type: "voice",
          content: "【语音】转写失败，稍后可重发（voice.ogg）",
          is_sensitive: false,
          meta: { media_status: "extract_failed" } as BackupNote["meta"],
          created_at: "2026-08-03 00:00:00",
          updated_at: "2026-08-03 00:00:00",
          attachments: [{ path: "media/old1/0-voice.ogg", name: "voice.ogg", mime: "audio/ogg", size: 2 }],
        },
      ],
      { "media/old1/0-voice.ogg": new Uint8Array([1, 2]) }
    );
    const tasks: Promise<unknown>[] = [];
    const result = await restoreBackup(env, "u9", streamOf(zip), (p) => tasks.push(p));
    await Promise.all(tasks);
    expect(result).toMatchObject({ notes_imported: 1, media_imported: 1 });
    const key = [...store.keys()][0];
    expect(key).toMatch(/\/\d+-voice\.ogg$/);
  });

  it("marks notes whose declared original did not make it (missing / oversized / failed) and lists them", async () => {
    const mkEnv = (store: Map<string, Uint8Array> | null, inserted: Recorded[]) =>
      ({
        DB: fakeDb({ inserted }),
        ...(store ? { MEDIA: fakeR2(store) } : {}),
        DEEPSEEK_API_KEY: "",
        DEEPSEEK_BASE_URL: "https://api.deepseek.com",
      }) as unknown as Env;
    const notes: Partial<BackupNote>[] = [
      {
        id: "old1",
        raw_type: "file",
        content: "【文件】已存档原件：blob.bin（暂不支持文本提取）",
        is_sensitive: false,
        meta: { file_name: "blob.bin", file_status: "extract_failed" } as BackupNote["meta"],
        created_at: "2026-08-03 00:00:00",
        attachments: [{ path: "media/old1/0-blob.bin", name: "blob.bin", mime: "application/octet-stream", size: 1 }],
      },
      {
        id: "old2",
        raw_type: "image",
        content: "图片里的文字",
        is_sensitive: false,
        created_at: "2026-08-03 00:00:01",
        attachments: [{ path: "media/old2/0-pic.png", name: "pic.png", mime: "image/png", size: 4 }],
      },
      {
        id: "old3",
        raw_type: "voice",
        content: "语音转写",
        is_sensitive: false,
        created_at: "2026-08-03 00:00:02",
        attachments: [{ path: "media/old3/0-voice.ogg", name: "voice.ogg", mime: "audio/ogg", size: 2 }],
      },
      {
        id: "old4",
        raw_type: "file",
        content: "两个附件",
        is_sensitive: false,
        created_at: "2026-08-03 00:00:03",
        attachments: [
          { path: "media/old4/0-a.txt", name: "a.txt", mime: "text/plain", size: 1 },
          { path: "media/old4/1-b.txt", name: "b.txt", mime: "text/plain", size: 1 },
        ],
      },
    ];
    // old1's entry is absent from the zip; old2's is over the per-file cap; old3 restores fine;
    // old4 declares two originals of which only the first arrived.
    // Directory entries (hand re-zipped backups) must not count as skipped media.
    const zip = zipSync({
      "manifest.json": strToU8(JSON.stringify({ format: BACKUP_FORMAT, version: 1 })),
      "notes.json": strToU8(JSON.stringify(notes)),
      "media/": new Uint8Array(0),
      "media/old2/": new Uint8Array(0),
      "media/old2/0-pic.png": new Uint8Array(15 * 1024 * 1024 + 1),
      "media/old3/0-voice.ogg": new Uint8Array([1, 2]),
      "media/old4/0-a.txt": new Uint8Array([1]),
    });

    const inserted: Recorded[] = [];
    const store = new Map<string, Uint8Array>();
    const tasks: Promise<unknown>[] = [];
    const result = await restoreBackup(mkEnv(store, inserted), "u9", streamOf(zip), (p) => tasks.push(p));
    await Promise.all(tasks);
    expect(result).toMatchObject({
      notes_imported: 4,
      media_imported: 2,
      media_skipped: 0,
      media_oversized: 1,
      media_failed: 0,
      media_missing: 2,
    });
    const stats = result as RestoreStats;
    const byName = Object.fromEntries(stats.media_missing_notes.map((m) => [m.name, m]));
    expect(Object.keys(byName).sort()).toEqual(["b.txt", "blob.bin", "pic.png"]);
    expect(byName["blob.bin"].reason).toBe("missing");
    expect(byName["pic.png"].reason).toBe("oversized");
    expect(byName["b.txt"].reason).toBe("missing");
    const noteIds = inserted.filter((r) => r.sql.includes("INSERT INTO notes")).map((r) => r.binds[0]);
    expect(noteIds).toContain(byName["blob.bin"].note_id);
    expect(noteIds).toContain(byName["pic.png"].note_id);
    const marks = inserted.filter((r) => r.sql.includes("json_patch") && r.sql.includes("UPDATE notes"));
    expect(marks.map((r) => [r.binds[1], r.binds[2], JSON.parse(String(r.binds[0]))])).toEqual(
      expect.arrayContaining([
        [byName["blob.bin"].note_id, "u9", { attachment_missing: "missing" }],
        [byName["pic.png"].note_id, "u9", { attachment_missing: "oversized" }],
        [byName["b.txt"].note_id, "u9", { attachment_missing: "missing" }],
      ])
    );
    expect(marks).toHaveLength(3);

    // no MEDIA bucket at all: every entry that arrived is a storage failure
    const inserted2: Recorded[] = [];
    const tasks2: Promise<unknown>[] = [];
    const result2 = await restoreBackup(mkEnv(null, inserted2), "u9", streamOf(zip), (p) => tasks2.push(p));
    await Promise.all(tasks2);
    expect(result2).toMatchObject({ media_imported: 0, media_failed: 2, media_oversized: 1, media_missing: 2 });
    const reasons = (result2 as RestoreStats).media_missing_notes.map((m) => m.reason).sort();
    expect(reasons).toEqual(["failed", "failed", "missing", "missing", "oversized"]);
  });

  it("restoreTodoDue: date / offset kept, legacy bare -> +08:00, anything else invalid", () => {
    expect(restoreTodoDue("2026-09-12")).toEqual({ due: "2026-09-12", invalid: null });
    expect(restoreTodoDue("2026-09-12T18:00:00+08:00")).toEqual({ due: "2026-09-12T18:00:00+08:00", invalid: null });
    expect(restoreTodoDue("2026-09-12T15:00:00.000Z")).toEqual({ due: "2026-09-12T15:00:00.000Z", invalid: null });
    expect(restoreTodoDue("2026-09-12 18:00:00-04:00")).toEqual({ due: "2026-09-12T18:00:00-04:00", invalid: null });
    // 历史无偏移值：与 normalizeStoredTodoDue 读路径同口径补 +08:00，落库后不再有裸值
    expect(restoreTodoDue("2026-09-12T15:50:55")).toEqual({ due: "2026-09-12T15:50:00+08:00", invalid: null });
    expect(restoreTodoDue("2026-09-12 15:50")).toEqual({ due: "2026-09-12T15:50:00+08:00", invalid: null });
    expect(restoreTodoDue(null)).toEqual({ due: null, invalid: null });
    expect(restoreTodoDue("  ")).toEqual({ due: null, invalid: null });
    expect(restoreTodoDue(123)).toEqual({ due: null, invalid: null });
    for (const bad of ["明天下午", "2026/09/12 18:00", "2026-09-12 6pm", "2026-13-45", "2026-9-12"])
      expect(restoreTodoDue(bad)).toEqual({ due: null, invalid: bad });
    expect(restoreTodoDue("x".repeat(100)).invalid).toHaveLength(40);
  });

  it("restore: unparseable todo_due is cleared + reported (note still imported, meta.todo_due_invalid), bare legacy normalized", async () => {
    const inserted: Recorded[] = [];
    const env = { DB: fakeDb({ inserted }), MEDIA: fakeR2(new Map()), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "" } as unknown as Env;
    const todo = (i: number, content: string, todo_due: string | null): Partial<BackupNote> => ({
      id: `old${i}`,
      source: "api",
      raw_type: "text",
      content,
      category: "todo",
      tags: [],
      is_sensitive: false,
      todo_due,
      todo_done: false,
      meta: { client_id: `c${i}` } as BackupNote["meta"],
      created_at: `2026-09-01 00:00:0${i}`,
      updated_at: `2026-09-01 00:00:0${i}`,
      attachments: [],
    });
    const zip = makeBackupZip([
      todo(1, "bare legacy", "2026-09-12T15:50:55"),
      todo(2, "garbage", "明天下午"),
      todo(3, "slash", "2026/09/12 18:00"),
      todo(4, "offset", "2026-09-12T18:00:00+08:00"),
      todo(5, "date", "2026-09-12"),
    ]);
    const tasks: Promise<unknown>[] = [];
    const result = await restoreBackup(env, "u9", streamOf(zip), (p) => tasks.push(p));
    await Promise.all(tasks);
    const stats = result as RestoreStats;
    expect(stats).toMatchObject({ notes_total: 5, notes_imported: 5, notes_skipped: 0, todo_due_invalid: 2 });
    expect(stats.todo_due_invalid_notes.map((m) => m.value).sort()).toEqual(["2026/09/12 18:00", "明天下午"]);

    const notes = inserted.filter((r) => r.sql.includes("INSERT INTO notes"));
    const byContent = Object.fromEntries(notes.map((r) => [r.binds[4] as string, r]));
    const due = (c: string) => byContent[c].binds[14];
    const meta = (c: string) => JSON.parse(String(byContent[c].binds[19] ?? "null")) as Record<string, unknown> | null;
    expect(due("bare legacy")).toBe("2026-09-12T15:50:00+08:00");
    expect(due("offset")).toBe("2026-09-12T18:00:00+08:00");
    expect(due("date")).toBe("2026-09-12");
    expect(due("garbage")).toBeNull();
    expect(due("slash")).toBeNull();
    expect(meta("garbage")).toMatchObject({ client_id: "c2", todo_due_invalid: "明天下午" });
    expect(meta("slash")).toMatchObject({ client_id: "c3", todo_due_invalid: "2026/09/12 18:00" });
    expect(meta("offset")).not.toHaveProperty("todo_due_invalid");
    // 上报的 note_id 就是新落库的 id
    const ids = new Set(notes.map((r) => r.binds[0] as string));
    for (const m of stats.todo_due_invalid_notes) expect(ids.has(m.note_id)).toBe(true);
  });

  it("skips duplicates (same content + created_at) including their media", async () => {
    const inserted: Recorded[] = [];
    const store = new Map<string, Uint8Array>();
    const env = {
      DB: fakeDb({ inserted, existing: [{ content: "已有的碎念", created_at: "2026-08-01 00:00:00" }] }),
      MEDIA: fakeR2(store),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const zip = makeBackupZip(
      [
        {
          id: "old1",
          content: "已有的碎念",
          created_at: "2026-08-01 00:00:00",
          updated_at: "2026-08-01 00:00:00",
          tags: [],
          is_sensitive: false,
          attachments: [{ path: "media/old1/0-pic.png", name: "0-pic.png", mime: "image/png", size: 4 }],
        },
      ],
      { "media/old1/0-pic.png": new Uint8Array([1]) }
    );
    const tasks: Promise<unknown>[] = [];
    const result = await restoreBackup(env, "u9", streamOf(zip), (p) => tasks.push(p));
    await Promise.all(tasks);
    expect(result).toMatchObject({ notes_total: 1, notes_imported: 0, notes_skipped: 1, media_imported: 0 });
    expect(inserted.filter((r) => r.sql.includes("INSERT INTO notes"))).toHaveLength(0);
    expect(store.size).toBe(0);
  });

  it("skips duplicate sensitive notes (placeholder-stored) on re-import", async () => {
    const inserted: Recorded[] = [];
    const env = {
      DB: fakeDb({
        inserted,
        sensExisting: [{ content: "[加密内容]", content_enc: null, created_at: "2026-08-02 00:00:00" }],
      }),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const zip = makeBackupZip([
      {
        id: "old2",
        content: "服务器密码 abc",
        is_sensitive: true,
        tags: [],
        created_at: "2026-08-02 00:00:00",
        updated_at: "2026-08-02 00:00:00",
        attachments: [],
      },
    ]);
    const result = await restoreBackup(env, "u9", streamOf(zip), () => undefined);
    expect(result).toMatchObject({ notes_total: 1, notes_imported: 0, notes_skipped: 1 });
    expect(inserted.filter((r) => r.sql.includes("INSERT INTO notes"))).toHaveLength(0);
  });

  it("dedups identical sensitive notes within one zip", async () => {
    const inserted: Recorded[] = [];
    const env = {
      DB: fakeDb({ inserted }),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const sens = {
      id: "old2",
      content: "服务器密码 abc",
      is_sensitive: true,
      tags: [],
      created_at: "2026-08-02 00:00:00",
      updated_at: "2026-08-02 00:00:00",
      attachments: [],
    };
    const zip = makeBackupZip([sens, { ...sens, id: "old3" }]);
    const result = await restoreBackup(env, "u9", streamOf(zip), () => undefined);
    expect(result).toMatchObject({ notes_total: 2, notes_imported: 1, notes_skipped: 1 });
  });

  it("rejects a zip without notes.json", async () => {
    const env = {
      DB: fakeDb({}),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const zip = zipSync({ "readme.txt": strToU8("hi") });
    const result = await restoreBackup(env, "u9", streamOf(zip), () => undefined);
    expect(result).toMatchObject({ status: 400 });
  });

  it("sensitive roundtrip (include_sensitive=true): plaintext in zip, re-encrypted at rest on restore", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const contentEnc = await encryptContent(key, "服务器密码 abc");
    const srcEnv = {
      DB: fakeDb({ notes: [{ ...SENSITIVE_NOTE, content: ENC_PLACEHOLDER, content_enc: contentEnc }] }),
      SUINIAN_ENC_KEY: key,
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const entries = await collectZip(srcEnv, true);
    const notes = JSON.parse(strFromU8(entries.get("notes.json")!)) as BackupNote[];
    expect(notes[0].content).toBe("服务器密码 abc");
    expect(notes[0].is_sensitive).toBe(true);

    const inserted: Recorded[] = [];
    const dstEnv = {
      DB: fakeDb({ inserted }),
      SUINIAN_ENC_KEY: key,
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const zipBytes = zipSync(Object.fromEntries([...entries.entries()]));
    const result = await restoreBackup(dstEnv, "u2", streamOf(zipBytes), () => undefined);
    expect(result).toMatchObject({ notes_total: 1, notes_imported: 1 });
    const ins = inserted.find((r) => r.sql.includes("INSERT INTO notes"))!;
    expect(ins.binds[4]).toBe(ENC_PLACEHOLDER); // content never stored in plaintext
    expect(ins.binds[12]).toBe(1); // is_sensitive kept
    const enc = ins.binds[13] as string;
    expect(enc).toBeTruthy();
    expect(await decryptContent(key, enc)).toBe("服务器密码 abc"); // plaintext recoverable
  });

  it("sensitive roundtrip (default redacted): placeholder in zip, no plaintext anywhere", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const contentEnc = await encryptContent(key, "服务器密码 abc");
    const srcEnv = {
      DB: fakeDb({ notes: [{ ...SENSITIVE_NOTE, content: ENC_PLACEHOLDER, content_enc: contentEnc }] }),
      SUINIAN_ENC_KEY: key,
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const entries = await collectZip(srcEnv, false);
    for (const data of entries.values()) {
      expect(strFromU8(data)).not.toContain("服务器密码 abc");
    }
    const notes = JSON.parse(strFromU8(entries.get("notes.json")!)) as BackupNote[];
    expect(notes[0].content).toBe(SENSITIVE_EXPORT_PLACEHOLDER);

    const inserted: Recorded[] = [];
    const dstEnv = {
      DB: fakeDb({ inserted }),
      SUINIAN_ENC_KEY: key,
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const zipBytes = zipSync(Object.fromEntries([...entries.entries()]));
    const result = await restoreBackup(dstEnv, "u2", streamOf(zipBytes), () => undefined);
    // R112 P2-2: the redacted placeholder shell has no recoverable plaintext —
    // it is skipped (and reported) instead of silently imported as a fake note
    expect(result).toMatchObject({ notes_total: 1, notes_imported: 0, sensitive_skipped: 1 });
    expect(inserted.filter((r) => r.sql.includes("INSERT INTO notes"))).toHaveLength(0);
  });

  it("full roundtrip: export zip restores losslessly on a fresh account", async () => {
    const media = new Map([[ATTACHMENT.r2_key, new Uint8Array([1, 2, 3, 4])]]);
    const srcEnv = {
      DB: fakeDb({ notes: [NOTE, IMAGE_NOTE], threads: [], attachments: [ATTACHMENT] }),
      MEDIA: fakeR2(media),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const tasks: Promise<unknown>[] = [];
    const res = await buildBackupZip(srcEnv, "u1", false, (p) => tasks.push(p));
    const zipBytes = new Uint8Array(await res.arrayBuffer());
    await Promise.all(tasks);

    const inserted: Recorded[] = [];
    const store = new Map<string, Uint8Array>();
    const dstEnv = {
      DB: fakeDb({ inserted }),
      MEDIA: fakeR2(store),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    } as unknown as Env;
    const tasks2: Promise<unknown>[] = [];
    const result = await restoreBackup(dstEnv, "u2", streamOf(zipBytes), (p) => tasks2.push(p));
    await Promise.all(tasks2);
    expect(result).toMatchObject({ notes_total: 2, notes_imported: 2, media_imported: 1 });
    expect([...store.values()].map((v) => Array.from(v))).toEqual([[1, 2, 3, 4]]);
  });
});
