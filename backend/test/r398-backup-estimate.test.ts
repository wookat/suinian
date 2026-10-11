// R398：GET /api/backup 的 X-Suinian-Backup-Estimate 预估总长——JSON 条目按开流前实际压缩字节、
// 媒体 STORE 条目按 attachments.size 计；全部原件在位时应与实际字节精确相等，
// R2 缺对象 / 解密失败被跳过时实际只会小于预估（差值恰为该条目占位）。
import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { buildBackupZip, BACKUP_ESTIMATE_HEADER, zipStoredEntryBytes, estimateBackupBytes } from "../src/backup";
import { attachmentDisplayName } from "../src/media";
import type { Env } from "../src/types";

const BASE_NOTE = {
  user_id: "u1",
  source: "web",
  raw_type: "text",
  url: null,
  url_title: null,
  url_summary: null,
  url_titles: null,
  category: "idea",
  tags: '["想法"]',
  thread_id: null,
  is_sensitive: 0,
  content_enc: null,
  todo_due: null,
  todo_done: 0,
  done_at: null,
  amount: null,
  currency: null,
  meta: null,
  created_at: "2026-08-01 00:00:00",
  updated_at: "2026-08-01 00:00:00",
  deleted_at: null,
};

function note(id: string, content: string, extra: Record<string, unknown> = {}) {
  return { ...BASE_NOTE, id, content, title: content.slice(0, 8), ...extra };
}

function fakeDb(opts: { notes: Record<string, unknown>[]; attachments: Record<string, unknown>[] }) {
  return {
    prepare(sql: string) {
      const make = (): unknown => ({
        bind() {
          return make();
        },
        async first() {
          return null;
        },
        async all() {
          if (sql.includes("FROM notes")) return { results: opts.notes };
          if (sql.includes("FROM threads")) return { results: [] };
          if (sql.includes("FROM weekly_reports")) return { results: [] };
          if (sql.includes("FROM attachments")) return { results: opts.attachments };
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      });
      return make();
    },
    async batch() {
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
            // 分两块送，模拟 R2 流式 body
            controller.enqueue(data.subarray(0, Math.floor(data.length / 2)));
            controller.enqueue(data.subarray(Math.floor(data.length / 2)));
            controller.close();
          },
        }),
        httpMetadata: { contentType: "application/octet-stream" },
      };
    },
  } as unknown as R2Bucket;
}

function bytesOf(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x >> 16;
  }
  return out;
}

async function run(env: Env, includeSensitive = false) {
  const tasks: Promise<unknown>[] = [];
  const res = await buildBackupZip(env, "u1", includeSensitive, (p) => tasks.push(p));
  const estimate = Number(res.headers.get(BACKUP_ESTIMATE_HEADER));
  const buf = new Uint8Array(await res.arrayBuffer());
  await Promise.all(tasks);
  return { estimate, actual: buf.length, entries: unzipSync(buf) };
}

const PIC = bytesOf(5000, 7);
const VOICE = bytesOf(12345, 11);
const ATT_PIC = { id: "a1", note_id: "n1", r2_key: "media/u1/n1/100-合同扫描件.png", mime: "image/png", size: PIC.length };
const ATT_VOICE = { id: "a2", note_id: "n1", r2_key: "media/u1/n1/200-voice.ogg", mime: "audio/ogg", size: VOICE.length };
const SECRET = bytesOf(777, 3);
const ATT_SECRET = { id: "a3", note_id: "n2", r2_key: "media/u1/n2/300-deploy.txt", mime: "text/plain", size: SECRET.length };

function envWith(store: Map<string, Uint8Array>, attachments: Record<string, unknown>[]) {
  return {
    DB: fakeDb({
      notes: [
        note("n1", "带两个附件的普通笔记，正文长一点让 deflate 有东西可压：" + "碎念".repeat(200)),
        note("n2", "服务器密码 abc", { is_sensitive: 1, tags: '["密码"]' }),
        note("n3", "没有附件的第三条"),
      ],
      attachments,
    }),
    MEDIA: fakeR2(store),
    DEEPSEEK_API_KEY: "",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com",
  } as unknown as Env;
}

describe("R398 backup size estimate header", () => {
  it("equals the actual zip length exactly when every original is present (CJK entry name included)", async () => {
    const store = new Map([
      [ATT_PIC.r2_key, PIC],
      [ATT_VOICE.r2_key, VOICE],
    ]);
    const { estimate, actual, entries } = await run(envWith(store, [ATT_PIC, ATT_VOICE]));
    expect(Object.keys(entries).filter((k) => k.startsWith("media/"))).toHaveLength(2);
    expect(estimate).toBe(actual);
    expect(actual).toBeGreaterThan(PIC.length + VOICE.length);
  });

  it("notes-only backup (no media): header still exact", async () => {
    const { estimate, actual, entries } = await run(envWith(new Map(), []));
    expect(Object.keys(entries)).toEqual(["manifest.json", "notes.json", "threads.json", "reports.json"]);
    expect(estimate).toBe(actual);
  });

  it("redacted backup leaves the sensitive note's attachment out of both zip and estimate", async () => {
    const store = new Map([
      [ATT_PIC.r2_key, PIC],
      [ATT_SECRET.r2_key, SECRET],
    ]);
    const { estimate, actual, entries } = await run(envWith(store, [ATT_PIC, ATT_SECRET]), false);
    expect(Object.keys(entries).some((k) => k.startsWith("media/n2/"))).toBe(false);
    expect(estimate).toBe(actual);
  });

  it("full backup with sensitive attachment present: exact", async () => {
    const store = new Map([
      [ATT_PIC.r2_key, PIC],
      [ATT_SECRET.r2_key, SECRET],
    ]);
    const { estimate, actual, entries } = await run(envWith(store, [ATT_PIC, ATT_SECRET]), true);
    expect(Object.keys(entries).some((k) => k.startsWith("media/n2/"))).toBe(true);
    expect(estimate).toBe(actual);
  });

  it("R2 object missing: actual is smaller than estimate by exactly that STORE entry", async () => {
    const store = new Map([[ATT_PIC.r2_key, PIC]]); // voice object gone
    const { estimate, actual, entries } = await run(envWith(store, [ATT_PIC, ATT_VOICE]));
    const mediaPaths = Object.keys(entries).filter((k) => k.startsWith("media/"));
    expect(mediaPaths).toHaveLength(1);
    // zip 条目名与生产同口径（attachmentDisplayName：r2_key 的 200- 是序号
    // 不是时间戳前缀，不会被剥掉）——写死 "1-voice.ogg" 会差 8 字节假失败。
    const missingPath = `media/n1/1-${attachmentDisplayName(ATT_VOICE.r2_key, ATT_VOICE.mime)}`;
    expect(entries[missingPath]).toBeUndefined();
    expect(estimate - actual).toBe(zipStoredEntryBytes(missingPath, VOICE.length));
    expect(actual).toBeLessThan(estimate);
  });

  it("attachments.size NULL counts as 0: estimate becomes a lower bound, header still present", async () => {
    const store = new Map([[ATT_PIC.r2_key, PIC]]);
    const { estimate, actual } = await run(envWith(store, [{ ...ATT_PIC, size: null }]));
    expect(Number.isFinite(estimate) && estimate > 0).toBe(true);
    expect(actual - estimate).toBe(PIC.length);
  });

  it("zip entry arithmetic matches fflate streaming layout", () => {
    // 本地头 30 + 名 + 体 + 数据描述符 16 + 中央目录项 46 + 名
    expect(zipStoredEntryBytes("a.bin", 100)).toBe(30 + 5 + 100 + 16 + 46 + 5);
    // 文件名按 UTF-8 字节数计，不是字符数
    expect(zipStoredEntryBytes("媳.bin", 0)).toBe(zipStoredEntryBytes("xyz.bin", 0));
    expect(estimateBackupBytes(1000, ["m.json"], [])).toBe(1000 + 22 + 46 + 6);
    expect(estimateBackupBytes(0, [], [{ path: "p", size: null }])).toBe(22 + zipStoredEntryBytes("p", 0));
  });
});
