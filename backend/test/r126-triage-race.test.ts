// R126 P0（R125 §1.1）：异步分拣回写绝不覆盖窗口期内的用户编辑。
// 复现路径：createNote 捕获创建时内容 → 用户 ~2s 内 PATCH → applyTriage 用旧
// 快照整行写回 → 用户编辑被静默回滚。修复口径：回写前比对库内明文与分拣快照
// + updated_at CAS；内容已变/CAS 失败 → 放弃回写并标 needs_retriage 交 cron。
import { describe, it, expect } from "vitest";
import { applyTriage } from "../src/note-store";
import type { TriageResult } from "../src/types";

type Row = Record<string, unknown>;

// 支持 CAS 谓词与 json_set(needs_retriage) 的最小状态化 fake D1
function fakeDb(notes: Row[], hooks?: { onSelect?: () => void }) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM notes")) {
            hooks?.onSelect?.();
            const n = notes.find((r) => r.id === binds[0]);
            return n ? { ...n } : null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.includes("json_set") && sql.includes("needs_retriage")) {
            const n = notes.find((r) => r.id === binds[0]);
            if (n) {
              const meta = n.meta ? JSON.parse(String(n.meta)) : {};
              meta.needs_retriage = true;
              n.meta = JSON.stringify(meta);
            }
            return { meta: { changes: n ? 1 : 0 } };
          }
          if (sql.startsWith("UPDATE notes SET")) {
            const whereIdx = sql.indexOf(" WHERE ");
            const setPart = sql.slice(0, whereIdx);
            const wherePart = sql.slice(whereIdx);
            const cols = [...setPart.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
            const nullCols = [...setPart.matchAll(/(\w+) = NULL/g)].map((m) => m[1]);
            const whereBinds = binds.slice(cols.length);
            let targets = notes.filter((n) => n.id === whereBinds[0]);
            if (wherePart.includes("updated_at = ?"))
              targets = targets.filter((n) => n.updated_at === whereBinds[whereBinds.length - 1]);
            for (const n of targets) {
              cols.forEach((col, i) => (n[col] = binds[i]));
              nullCols.forEach((col) => (n[col] = null));
              if (/updated_at = datetime\('now'\)/.test(setPart)) n.updated_at = `bumped-${Date.now()}-${Math.random()}`;
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

const baseNote = (over: Row = {}): Row => ({
  id: "n1",
  user_id: "u1",
  content: "原始内容",
  content_enc: null,
  title: null,
  tags: "[]",
  category: null,
  todo_due: null,
  is_sensitive: 0,
  meta: null,
  url_title: null,
  url_summary: null,
  url_titles: null,
  updated_at: "2026-08-07 00:00:00",
  ...over,
});

const triage: TriageResult = {
  category: "idea",
  tags: ["ai-tag"],
  title: "AI 标题",
  is_sensitive: false,
  todo_due: null,
};

function env(notes: Row[], hooks?: { onSelect?: () => void }) {
  return { DB: fakeDb(notes, hooks) } as unknown as { DB: D1Database; SUINIAN_ENC_KEY?: string };
}

describe("applyTriage 写后写竞态（R126 P0）", () => {
  it("创建后立即编辑：分拣回写发现内容已变 → 不覆盖任何字段，只标 needs_retriage", async () => {
    const notes = [baseNote({ content: "用户编辑后的内容", updated_at: "2026-08-07 00:00:02" })];
    await applyTriage(env(notes), "n1", triage, "原始内容");
    expect(notes[0].content).toBe("用户编辑后的内容");
    expect(notes[0].title).toBeNull();
    expect(notes[0].category).toBeNull();
    expect(JSON.parse(String(notes[0].meta)).needs_retriage).toBe(true);
  });

  it("SELECT 后、UPDATE 前被并发写入抢先（CAS 失败）→ 放弃回写并标 needs_retriage", async () => {
    const notes = [baseNote()];
    let raced = false;
    const e = env(notes, {
      onSelect: () => {
        if (raced) return;
        raced = true;
        // 分拣读到快照后，另一并发请求提交：内容与版本同时变化
        notes[0].content = "并发提交的内容";
        notes[0].updated_at = "2026-08-07 00:00:03";
      },
    });
    await applyTriage(e, "n1", triage, "原始内容");
    expect(notes[0].content).toBe("并发提交的内容");
    expect(notes[0].title).toBeNull();
    expect(JSON.parse(String(notes[0].meta)).needs_retriage).toBe(true);
  });

  it("无并发编辑时正常落库分拣派生字段", async () => {
    const notes = [baseNote()];
    await applyTriage(env(notes), "n1", triage, "原始内容");
    expect(notes[0].category).toBe("idea");
    expect(notes[0].title).toBe("AI 标题");
    expect(notes[0].tags).toBe('["ai-tag"]');
    expect(notes[0].content).toBe("原始内容");
  });

  it("创建后立即编辑 ×N 并发：最终内容永远是用户的最后编辑", async () => {
    for (let i = 0; i < 20; i++) {
      const notes = [baseNote()];
      const e = env(notes);
      // 模拟用户在分拣异步窗口内的编辑（PATCH 路径已带自身 CAS）
      const userEdit = (async () => {
        notes[0].content = `用户第 ${i} 次编辑`;
        notes[0].updated_at = `2026-08-07 00:00:0${(i % 9) + 1}`;
      })();
      const triageWrite = applyTriage(e, "n1", triage, "原始内容");
      await Promise.all([userEdit, triageWrite]);
      expect(notes[0].content).toBe(`用户第 ${i} 次编辑`);
      expect(JSON.parse(String(notes[0].meta)).needs_retriage).toBe(true);
    }
  });
});
