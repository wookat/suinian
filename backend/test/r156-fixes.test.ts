// R156：落实 R155 审查结论的回归测试——
// P1-1 搜索 LIKE 模式统一 capBytes 收口（D1 pattern too complex → 500）；
// P1-2 导入/恢复附件统一走 storeOriginal 管道（敏感原件写入时即加密）；
// P2-1 敏感笔记重复导入去重（明文指纹 import_fp，密文占位符不可比对）。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { capBytes, likeContains, tagLikePattern, searchTerms } from "../src/index";
import { contentFingerprint, isEncryptedAttachment, ENC_PLACEHOLDER } from "../src/crypto";
import { runImport, sweepImportDedupe, type ImportItem } from "../src/import";
import { unzipEntries, parseCuboxZip, parseObsidianZip } from "../src/import-zip";

const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const enc = new TextEncoder();

describe("R156 P1-1：搜索 LIKE 模式字节裁剪统一收口", () => {
  it("capBytes 按 UTF-8 字节裁剪，不切坏多字节字符", () => {
    const cjk = "这是一个超过十六个汉字的超长中文句子测试用例";
    const capped = capBytes(cjk, 45);
    expect(enc.encode(capped).length).toBeLessThanOrEqual(45);
    expect(cjk.startsWith(capped)).toBe(true);
    expect(capBytes("short", 45)).toBe("short");
  });
  it("likeContains 对超长中文词裁剪到 45 字节以内", () => {
    const long = "粘贴一整句话进搜索框单词超过十六个汉字必然五百".repeat(2);
    const p = likeContains(long);
    expect(p.startsWith("%")).toBe(true);
    expect(p.endsWith("%")).toBe(true);
    expect(enc.encode(p).length).toBeLessThanOrEqual(47);
  });
  it("likeContains 对超长 ASCII 词同样裁剪", () => {
    const p = likeContains("a".repeat(200));
    expect(enc.encode(p).length).toBeLessThanOrEqual(47);
  });
  it("searchTerms 每个词都在字节上限内", () => {
    const q = "汉字超过十六个的第一个超长词语测试 second-very-long-".padEnd(120, "x");
    for (const t of searchTerms(q)) expect(enc.encode(t).length).toBeLessThanOrEqual(45);
  });
  it("tagLikePattern 正常标签保持精确 JSON 匹配，超长标签退化为前缀匹配", () => {
    expect(tagLikePattern("读书")).toBe('%"读书"%');
    const long = "标签超过四十五字节的超长标签名称测试用例";
    const p = tagLikePattern(long);
    expect(p.endsWith('"%')).toBe(false);
    expect(enc.encode(p).length).toBeLessThanOrEqual(48);
  });
});

describe("R156 P2-1：内容指纹", () => {
  it("同内容指纹稳定，异内容不同", async () => {
    const a1 = await contentFingerprint(KEY, "内容A");
    const a2 = await contentFingerprint(KEY, "内容A");
    const b = await contentFingerprint(KEY, "内容B");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });
  it("有密钥时为 HMAC（与无密钥 SHA-256 不同），防 DB 泄露字典反猜", async () => {
    const hmac = await contentFingerprint(KEY, "同一内容");
    const sha = await contentFingerprint(undefined, "同一内容");
    expect(hmac).not.toBe(sha);
  });
});

// ---- 架构级静态断言（参照 write-path-guard）：附件写入唯一走 media.ts ----
describe("R156 P1-2：附件写路径只允许 media.ts（storeOriginal/同步加密）", () => {
  const SRC_DIR = new URL("../src", import.meta.url).pathname;
  const files = (dir: string = SRC_DIR): string[] => {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...files(p));
      else if (e.name.endsWith(".ts") && relative(SRC_DIR, p) !== "media.ts") out.push(p);
    }
    return out;
  };
  it("src（除 media.ts）不得出现 MEDIA.put / INSERT INTO attachments", () => {
    const offenders: string[] = [];
    for (const f of files()) {
      const text = readFileSync(f, "utf8");
      if (/MEDIA[!.?]+put\s*\(/.test(text)) offenders.push(`${relative(SRC_DIR, f)}: MEDIA.put`);
      if (/INSERT\s+INTO\s+attachments/i.test(text)) offenders.push(`${relative(SRC_DIR, f)}: INSERT INTO attachments`);
    }
    expect(offenders).toEqual([]);
  });
});

// ---- P2：zip 文件名 latin-1 乱码纠正 + Cubox zip 支持 ----

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 造一个未置 UTF-8 flag 的存储式 zip（单文件），复现 R155 P2-1 乱码场景 */
function makeZipNoUtf8Flag(nameBytes: Uint8Array, data: Uint8Array): Uint8Array {
  const crc = crc32(data);
  const lfh = new Uint8Array(30 + nameBytes.length);
  const lv = new DataView(lfh.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint32(14, crc, true);
  lv.setUint32(18, data.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, nameBytes.length, true);
  lfh.set(nameBytes, 30);
  const cdh = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(cdh.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(4, 20, true);
  cv.setUint16(6, 20, true);
  cv.setUint32(16, crc, true);
  cv.setUint32(20, data.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cdh.set(nameBytes, 46);
  const cdOffset = lfh.length + data.length;
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, cdh.length, true);
  ev.setUint32(16, cdOffset, true);
  const out = new Uint8Array(cdOffset + cdh.length + eocd.length);
  out.set(lfh, 0);
  out.set(data, lfh.length);
  out.set(cdh, cdOffset);
  out.set(eocd, cdOffset + cdh.length);
  return out;
}

describe("R156 P2-2/P2-3：zip 文件名乱码纠正 + Cubox zip", () => {
  it("未置 UTF-8 flag 的中文文件名不再变成 latin-1 乱码", () => {
    const zip = makeZipNoUtf8Flag(enc.encode("每周复盘模板.md"), enc.encode("# 每周复盘模板\n内容"));
    const entries = unzipEntries(zip);
    expect(Object.keys(entries)).toEqual(["每周复盘模板.md"]);
  });
  it("parseCuboxZip 同时解析包内 md 与 CSV", () => {
    const entries: Record<string, Uint8Array> = {
      "收藏A.md": enc.encode("# 收藏A\n正文内容"),
      "cubox.csv": enc.encode("标题,链接,创建时间\n收藏B,https://example.com/b,2025-01-02 10:00:00\n"),
    };
    const r = parseCuboxZip(entries);
    expect(r.failures).toEqual([]);
    expect(r.items.map((i) => i.content.split("\n")[0]).sort()).toEqual(["# 收藏A", "收藏B"]);
  });
  it("md 中标准 ![](path) 图片引用与 ![[wikilink]] 一样收集为资产", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const entries: Record<string, Uint8Array> = {
      "笔记.md": enc.encode("正文\n![截图](pin.png)\n![[embed.png]]"),
      "pin.png": png,
      "embed.png": png,
    };
    const r = parseObsidianZip(entries);
    expect(r.failures).toEqual([]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0].assets?.map((a) => a.name).sort()).toEqual(["embed.png", "pin.png"]);
    expect(r.items[0].content).toContain("【图片：pin.png】");
    expect(r.assets_dropped).toBe(0);
  });
});

// ---- runImport 集成：内存 fake D1/R2 ----
interface FakeNote {
  id: string;
  user_id: string;
  content: string;
  is_sensitive: number;
  content_enc: string | null;
  meta: string | null;
  created_at: string;
  deleted_at: string | null;
}

function fakeEnv(withKey: boolean) {
  const notes: FakeNote[] = [];
  const attachments: { note_id: string; r2_key: string; mime: string }[] = [];
  const r2 = new Map<string, Uint8Array>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...b: unknown[]) {
          return {
            async all() {
              if (sql.includes("json_extract(meta, '$.import_fp') IN")) {
                // dedup 查询：binds = [userId, ...contents, ...fps]
                const n = (b.length - 1) / 2;
                const contents = b.slice(1, 1 + n) as string[];
                const fps = b.slice(1 + n) as string[];
                const results = notes
                  .filter((r) => r.user_id === b[0] && !r.deleted_at)
                  .filter((r) => {
                    const fp = r.meta ? (JSON.parse(r.meta) as { import_fp?: string }).import_fp : undefined;
                    return contents.includes(r.content) || (fp !== undefined && fps.includes(fp));
                  })
                  .map((r) => ({
                    content: r.content,
                    created_at: r.created_at,
                    fp: r.meta ? ((JSON.parse(r.meta) as { import_fp?: string }).import_fp ?? null) : null,
                  }));
                return { results };
              }
              if (sql.includes("'$.import_fp') IS NULL")) {
                const results = notes
                  .filter((r) => !r.deleted_at && r.meta && (JSON.parse(r.meta) as { import_source?: string }).import_source)
                  .filter((r) => (JSON.parse(r.meta!) as { import_fp?: string }).import_fp === undefined)
                  .map((r) => ({ id: r.id, content: r.content, content_enc: r.content_enc }));
                return { results };
              }
              if (sql.includes("rowid > (SELECT MIN(m.rowid)")) {
                const seen = new Map<string, string>();
                const dups: { id: string }[] = [];
                for (const r of notes) {
                  if (r.deleted_at || !r.meta) continue;
                  const fp = (JSON.parse(r.meta) as { import_fp?: string }).import_fp;
                  if (!fp) continue;
                  const k = `${r.user_id}\u0000${r.created_at}\u0000${fp}`;
                  if (seen.has(k)) dups.push({ id: r.id });
                  else seen.set(k, r.id);
                }
                return { results: dups };
              }
              throw new Error(`fake all() unhandled: ${sql}`);
            },
            async first() {
              if (sql.includes("SELECT is_sensitive FROM notes")) {
                const row = notes.find((r) => r.id === b[0]);
                return row ? { is_sensitive: row.is_sensitive } : null;
              }
              throw new Error(`fake first() unhandled: ${sql}`);
            },
            async run() {
              if (sql.startsWith("INSERT INTO notes")) {
                notes.push({
                  id: b[0] as string,
                  user_id: b[1] as string,
                  content: b[4] as string,
                  is_sensitive: b[12] as number,
                  content_enc: b[13] as string | null,
                  meta: b[19] as string | null,
                  created_at: (b[20] as string | null) ?? "2026-01-01 00:00:00",
                  deleted_at: null,
                });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("INSERT INTO attachments")) {
                attachments.push({ note_id: b[1] as string, r2_key: b[2] as string, mime: b[3] as string });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("json_set(coalesce(meta, '{}'), '$.import_fp'")) {
                const row = notes.find((r) => r.id === b[1]);
                if (row) row.meta = JSON.stringify({ ...(row.meta ? JSON.parse(row.meta) : {}), import_fp: b[0] });
                return { meta: { changes: 1 } };
              }
              if (sql.includes("SET deleted_at = datetime('now')")) {
                const row = notes.find((r) => r.id === b[0]);
                if (row) row.deleted_at = "2026-01-02 00:00:00";
                return { meta: { changes: 1 } };
              }
              throw new Error(`fake run() unhandled: ${sql}`);
            },
          };
        },
      };
    },
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  } as unknown as D1Database;
  const media = {
    async put(key: string, value: Uint8Array) {
      r2.set(key, value);
    },
  } as unknown as R2Bucket;
  return {
    env: { DB: db, MEDIA: media, ...(withKey ? { SUINIAN_ENC_KEY: KEY } : {}) },
    notes,
    attachments,
    r2,
  };
}

const SENSITIVE_CONTENT = "服务器 root 口令 P@ss2026 记一下";

describe("R156 P2-1：敏感笔记重复导入去重（import_fp）", () => {
  const items: ImportItem[] = [
    { content: SENSITIVE_CONTENT, created_at: "2025-06-01 08:00:00", tags: [], url: null },
    { content: "普通笔记内容", created_at: "2025-06-01 09:00:00", tags: [], url: null },
  ];
  it("同文件重复导入第二次全部跳过（含敏感笔记）", async () => {
    const f = fakeEnv(true);
    const r1 = await runImport(f.env, "u1", "flomo", items);
    expect(r1.stats.imported).toBe(2);
    // 敏感笔记落库后 content 只剩占位符
    const sens = f.notes.find((n) => n.is_sensitive === 1);
    expect(sens?.content).toBe(ENC_PLACEHOLDER);
    expect(sens && JSON.parse(sens.meta!)).toHaveProperty("import_fp");
    const r2 = await runImport(f.env, "u1", "flomo", items);
    expect(r2.stats.imported).toBe(0);
    expect(r2.stats.skipped).toBe(2);
  });
  it("sweepImportDedupe 回填存量指纹并软删重复行", async () => {
    const f = fakeEnv(true);
    await runImport(f.env, "u1", "flomo", items);
    // 模拟修复前的存量重复：抹掉指纹后再导入一遍 → 去重失效产生重复行
    for (const n of f.notes) {
      const meta = JSON.parse(n.meta!) as Record<string, unknown>;
      delete meta.import_fp;
      n.meta = JSON.stringify(meta);
    }
    await runImport(f.env, "u1", "flomo", items);
    // 非敏感行仍被明文比对拦住，只有敏感行重复入库（复现 R155 n=2 现象）
    expect(f.notes.filter((n) => !n.deleted_at)).toHaveLength(3);
    const stats = await sweepImportDedupe(f.env);
    expect(stats.fp_backfilled).toBe(2);
    expect(stats.duplicates_removed).toBe(1);
    expect(f.notes.filter((n) => !n.deleted_at)).toHaveLength(2);
  });
});

describe("R156 P1-2：导入附件走 storeOriginal（敏感原件写入即加密）", () => {
  it("敏感笔记的导入图片以 SNE1 信封落 R2，非敏感保持明文", async () => {
    const f = fakeEnv(true);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const items: ImportItem[] = [
      {
        content: SENSITIVE_CONTENT,
        created_at: "2025-06-01 08:00:00",
        tags: [],
        url: null,
        assets: [{ name: "secret.png", mime: "image/png", bytes }],
      },
      {
        content: "普通带图笔记",
        created_at: "2025-06-01 09:00:00",
        tags: [],
        url: null,
        assets: [{ name: "plain.png", mime: "image/png", bytes }],
      },
    ];
    const r = await runImport(f.env, "u1", "flomo", items);
    expect(r.stats.imported).toBe(2);
    expect(f.attachments).toHaveLength(2);
    const sensId = f.notes.find((n) => n.is_sensitive === 1)!.id;
    const plainId = f.notes.find((n) => n.is_sensitive === 0)!.id;
    const sensObj = f.r2.get(f.attachments.find((a) => a.note_id === sensId)!.r2_key)!;
    const plainObj = f.r2.get(f.attachments.find((a) => a.note_id === plainId)!.r2_key)!;
    expect(isEncryptedAttachment(sensObj)).toBe(true);
    expect(isEncryptedAttachment(plainObj)).toBe(false);
    expect(Array.from(plainObj)).toEqual(Array.from(bytes));
  });
});
