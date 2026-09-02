// 架构级静态断言（R124 P1-1，R126 补齐 R125 §1.2 探针）：notes 内容字段
// （content/content_enc/title/tags/is_sensitive）的 INSERT/UPDATE SQL 只允许
// 出现在唯一持久层 src/note-store.ts。R117→R119→R121→R123 连续四轮「另一个
// 入口」同型缺陷的结构性终结：任何新入口直接手写这些字段的 SQL 都会让本测试
// 失败，逼迫其走 note-store 的敏感管道。全量写路径清单见 docs/write-paths.md。
//
// R126 覆盖的等价写法（R125 §1.2 五种绕过探针）：
//   UPDATE "notes" / UPDATE main.notes / REPLACE INTO notes /
//   INSERT OR REPLACE INTO "notes" / 字符串拼列名（SET 子句动态拼接）。
// 扫描范围：backend/src 递归全部 .ts（含子目录）。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_DIR = new URL("../src", import.meta.url).pathname;
/** 唯一允许出现 notes 守护字段写 SQL 的模块 */
const DAO_FILE = "note-store.ts";
/** 守护字段：写入必须经敏感管道（加密/title 置空/tags 严格过滤） */
const GUARDED = ["content", "content_enc", "title", "tags", "is_sensitive"];

/** `xxx = ?` / `xxx = NULL` / `xxx = 'v'` 形式的 SET 片段命中守护字段（url_title 等不算） */
const GUARDED_SET_RE = new RegExp(`(?<![0-9A-Za-z_.$"'\`])(${GUARDED.join("|")})["'\`]?\\s*=`, "g");

// notes 表的全部合法 SQLite 写法：裸表名 / 双引号 / 反引号 / 方括号 /
// schema 限定（main.notes、"main"."notes"）
const NOTES_TABLE = `(?:(?:[A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*"|\`[A-Za-z_][A-Za-z0-9_]*\`)\\s*\\.\\s*)?(?:notes\\b|"notes"|\`notes\`|\\[notes\\])`;
const UPDATE_NOTES_RE = new RegExp(`\\bUPDATE\\s+(?:OR\\s+[A-Za-z]+\\s+)?${NOTES_TABLE}`, "i");
const INSERT_NOTES_RE = new RegExp(`\\b(?:INSERT\\s+(?:OR\\s+[A-Za-z]+\\s+)?INTO|REPLACE\\s+INTO)\\s+${NOTES_TABLE}`, "i");

function sourceFiles(dir: string = SRC_DIR): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith(".ts") && relative(SRC_DIR, p) !== DAO_FILE) out.push(p);
  }
  return out;
}

/** 提取文件里所有字符串/模板字面量（跨行）。 */
function stringLiterals(text: string): string[] {
  // 线性扫描而非回溯正则：`(?:\\.|[\s\S])*?` 在含大量反斜杠的正则源码上会指数回溯
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const q = text[i];
    if (q !== '"' && q !== "'" && q !== "`") {
      i++;
      continue;
    }
    let j = i + 1;
    let closed = false;
    while (j < text.length) {
      const c = text[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === q) {
        closed = true;
        break;
      }
      j++;
    }
    if (!closed) {
      i++;
      continue;
    }
    out.push(text.slice(i + 1, j));
    i = j + 1;
  }
  return out;
}

/** 命中 notes 写 SQL（含全部等价写法）的字面量。 */
function noteWriteSql(text: string): string[] {
  return stringLiterals(text).filter((s) => UPDATE_NOTES_RE.test(s) || INSERT_NOTES_RE.test(s));
}

describe("write-path guard: notes 守护字段只能经 note-store 落库", () => {
  it("src 递归（除 note-store.ts）不得包含 INSERT/REPLACE INTO notes（含等价写法）", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const text = readFileSync(f, "utf8");
      for (const sql of noteWriteSql(text)) {
        if (INSERT_NOTES_RE.test(sql)) offenders.push(`${relative(SRC_DIR, f)}: ${sql.slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("src 递归（除 note-store.ts）的 UPDATE notes 不得 SET 守护字段，SET 子句不得动态拼接", () => {
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const text = readFileSync(f, "utf8");
      for (const sql of noteWriteSql(text)) {
        if (!UPDATE_NOTES_RE.test(sql)) continue;
        const setIdx = sql.search(/\bSET\b/i);
        const whereIdx = sql.search(/\bWHERE\b/i);
        if (setIdx < 0) {
          // 「"UPDATE notes SET " + col」拼列名探针会把 SET 留在字面量末尾/
          // 或根本没有 SET——没有完整可静态审计的 SET 子句即视为违规
          offenders.push(`${relative(SRC_DIR, f)}: dynamic/missing SET -> ${sql.slice(0, 120)}`);
          continue;
        }
        const setPart = sql.slice(setIdx, whereIdx >= 0 ? whereIdx : sql.length);
        // SET 子句以拼接边界结尾（如 "UPDATE notes SET " + col + " = ?"）：
        // 列名不可静态审计，一律违规
        if (/\bSET\s*$/i.test(setPart) || /\$\{/.test(setPart)) {
          offenders.push(`${relative(SRC_DIR, f)}: dynamic SET clause -> ${sql.slice(0, 120)}`);
          continue;
        }
        const hits = [...setPart.matchAll(GUARDED_SET_RE)].map((m) => m[1]);
        if (hits.length > 0) offenders.push(`${relative(SRC_DIR, f)}: SET ${hits.join(",")} -> ${sql.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("动态拼接 sets 的守护字段片段也不得出现在业务代码", () => {
    // 形如 sets.push("title = ?") / "tags = ?" / '"title" = ?' 的动态 UPDATE 拼接
    const FRAG_RE = new RegExp(`["'\`]\\s*["'\`]?(${GUARDED.join("|")})["'\`]?\\s*=\\s*(\\?|NULL)`, "g");
    const offenders: string[] = [];
    for (const f of sourceFiles()) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(FRAG_RE)) {
        // 完整 SQL 字面量里的命中已由上面两条覆盖；这里抓孤立片段
        offenders.push(`${relative(SRC_DIR, f)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // R125 §1.2 对抗探针自测：五种合法 SQLite 等价写法必须全部被断言逻辑识破。
  describe("R125 §1.2 绕过探针全部命中", () => {
    const probes: [string, string][] = [
      ["双引号表名", 'UPDATE "notes" SET content = ?, is_sensitive = 0 WHERE id = ?'],
      ["schema 限定", "UPDATE main.notes SET content = ?, title = ? WHERE id = ?"],
      ["REPLACE INTO", "REPLACE INTO notes (id,user_id,content,is_sensitive) VALUES (?,?,?,?)"],
      ["INSERT OR REPLACE", 'INSERT OR REPLACE INTO "notes" (id,user_id,content) VALUES (?,?,?)'],
    ];
    for (const [name, sql] of probes) {
      it(`探针：${name}`, () => {
        expect(UPDATE_NOTES_RE.test(sql) || INSERT_NOTES_RE.test(sql)).toBe(true);
        if (UPDATE_NOTES_RE.test(sql)) {
          const setPart = sql.slice(sql.search(/\bSET\b/i), sql.search(/\bWHERE\b/i));
          expect([...setPart.matchAll(GUARDED_SET_RE)].length).toBeGreaterThan(0);
        }
      });
    }
    it("探针：字符串拼列名（UPDATE notes SET + col）", () => {
      const literal = "UPDATE notes SET "; // "UPDATE notes SET " + col + " = ?"
      expect(UPDATE_NOTES_RE.test(literal)).toBe(true);
      expect(/\bSET\s*$/i.test(literal)).toBe(true);
    });
    it("探针：基线裸写法仍命中", () => {
      expect(UPDATE_NOTES_RE.test("UPDATE notes SET content = ? WHERE id = ?")).toBe(true);
      expect(INSERT_NOTES_RE.test("INSERT INTO notes (id) VALUES (?)")).toBe(true);
    });
  });
});
