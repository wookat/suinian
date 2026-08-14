// 架构级静态断言（R124 P1-1）：notes 内容字段（content/content_enc/title/tags/
// is_sensitive）的 INSERT/UPDATE SQL 只允许出现在唯一持久层 src/note-store.ts。
// R117→R119→R121→R123 连续四轮「另一个入口」同型缺陷的结构性终结：任何新入口
// 直接手写这些字段的 SQL 都会让本测试失败，逼迫其走 note-store 的敏感管道。
// 全量写路径清单见 docs/write-paths.md。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = new URL("../src", import.meta.url).pathname;
/** 唯一允许出现 notes 守护字段写 SQL 的模块 */
const DAO_FILE = "note-store.ts";
/** 守护字段：写入必须经敏感管道（加密/title 置空/tags 严格过滤） */
const GUARDED = ["content", "content_enc", "title", "tags", "is_sensitive"];

/** `xxx = ?` / `xxx = NULL` / `xxx = 'v'` 形式的 SET 片段命中守护字段（url_title 等不算） */
const GUARDED_SET_RE = new RegExp(`(?<![0-9A-Za-z_.$])(${GUARDED.join("|")})\\s*=`, "g");

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts") && f !== DAO_FILE);
}

/** 提取文件里所有含 UPDATE notes / INSERT INTO notes 的模板串/字符串字面量（跨行）。 */
function noteWriteSql(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    const s = m[2];
    if (/\bUPDATE\s+notes\b/i.test(s) || /\bINSERT\s+INTO\s+notes\b/i.test(s)) out.push(s);
  }
  return out;
}

describe("write-path guard: notes 守护字段只能经 note-store 落库", () => {
  it("src（除 note-store.ts）不得包含 INSERT INTO notes", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const text = readFileSync(join(SRC_DIR, f), "utf8");
      for (const sql of noteWriteSql(text)) {
        if (/\bINSERT\s+INTO\s+notes\b/i.test(sql)) offenders.push(`${f}: ${sql.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src（除 note-store.ts）的 UPDATE notes 不得 SET 守护字段", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const text = readFileSync(join(SRC_DIR, f), "utf8");
      for (const sql of noteWriteSql(text)) {
        if (!/\bUPDATE\s+notes\b/i.test(sql)) continue;
        const setPart = sql.slice(sql.search(/\bSET\b/i), sql.search(/\bWHERE\b/i) >= 0 ? sql.search(/\bWHERE\b/i) : sql.length);
        const hits = [...setPart.matchAll(GUARDED_SET_RE)].map((m) => m[1]);
        if (hits.length > 0) offenders.push(`${f}: SET ${hits.join(",")} -> ${sql.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("动态拼接 sets 的守护字段片段也不得出现在业务代码", () => {
    // 形如 sets.push("title = ?") / "tags = ?" 的动态 UPDATE 拼接
    const FRAG_RE = new RegExp(`["'\`](${GUARDED.join("|")})\\s*=\\s*(\\?|NULL)`, "g");
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const text = readFileSync(join(SRC_DIR, f), "utf8");
      for (const m of text.matchAll(FRAG_RE)) {
        // 完整 SQL 字面量里的命中已由上面两条覆盖；这里抓孤立片段
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
