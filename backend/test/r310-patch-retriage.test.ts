// R310 P1：audit-r309 §6「编辑金额 99→199 后同问仍给 99（hit=false）」——根因不在缓存：
// PATCH content 只重算 AI 标题（recomputeTitle），amount/currency 列保持旧值，
// 确定性账目路由读列即读到 99。修复：内容变更后走 applyTriage 全量复判。
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/triage", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/triage")>();
  return {
    ...mod,
    triageNote: vi.fn(async (content: string) => ({
      category: "expense",
      tags: ["买书"],
      title: content.slice(0, 10),
      is_sensitive: false,
      amount: /199/.test(content) ? 199 : 99,
      currency: "CNY",
    })),
    loadTopTags: vi.fn(async () => []),
    loadCategoryCorrections: vi.fn(async () => []),
    loadUserTz: vi.fn(async () => "Asia/Shanghai"),
  };
});

import { app } from "../src/index";

type Row = Record<string, unknown>;

const BASE: Row = {
  id: "n1",
  user_id: "u1",
  source: "api",
  raw_type: "text",
  category: "expense",
  amount: 99,
  currency: "CNY",
  tags: '["买书"]',
  title: "买算法导论",
  url: null,
  url_title: null,
  url_summary: null,
  url_titles: null,
  meta: null,
  is_sensitive: 0,
  todo_due: null,
  todo_done: 0,
  thread_id: null,
  content: "买书 《算法导论》 花了 99 元",
  content_enc: null,
  created_at: "2026-08-07 00:00:00",
  updated_at: "2026-08-07 00:00:00",
};

function fakeDb(note: Row) {
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
          if (sql.includes("FROM notes")) return { ...note };
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET")) {
            const cols = [...sql.matchAll(/(\w+) = (?:\?|coalesce\(\w+, \?\))/g)].map((m) => m[1]);
            cols.forEach((col, i) => {
              note[col] = binds[i];
            });
            note.updated_at = `2026-08-07 00:00:0${Number(String(note.updated_at).slice(-1)) + 1}`;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

function env(note: Row) {
  return { DB: fakeDb(note), DEEPSEEK_API_KEY: "", DEEPSEEK_BASE_URL: "https://api.deepseek.com" };
}

function ctxCollect() {
  const tasks: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil(p: Promise<unknown>) { tasks.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext,
    settle: () => Promise.allSettled(tasks),
  };
}

function patch(body: Record<string, unknown>) {
  return new Request("http://x/api/notes/n1", {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: "Bearer good-token" },
    body: JSON.stringify(body),
  });
}

describe("R310 P1：编辑正文后金额列跟随新内容（audit-r309 §6 旧值根因）", () => {
  it("99 → 199：PATCH 后 amount 列为 199，title 同步重算", async () => {
    const note: Row = { ...BASE };
    const { ctx, settle } = ctxCollect();
    const res = await app.request(patch({ content: "买书 《算法导论》 花了 199 元" }), undefined, env(note), ctx);
    expect(res.status).toBe(200);
    await settle();
    expect(note.content).toBe("买书 《算法导论》 花了 199 元");
    expect(note.amount).toBe(199);
    expect(note.currency).toBe("CNY");
    expect(String(note.title)).toMatch(/^买书 《算法导论》/);
  });

  it("手动锁定分类（manual_override.category）：分类不动，金额仍按新正文补写", async () => {
    const note: Row = { ...BASE, category: "data", meta: JSON.stringify({ manual_override: { category: true } }) };
    const { ctx, settle } = ctxCollect();
    const res = await app.request(patch({ content: "买书 《算法导论》 花了 199 元" }), undefined, env(note), ctx);
    expect(res.status).toBe(200);
    await settle();
    expect(note.category).toBe("data");
    expect(note.amount).toBe(199);
  });

  it("手动定过标题（manual_override.title）：标题不被覆盖，金额照常更新", async () => {
    const note: Row = { ...BASE, title: "我的书单", meta: JSON.stringify({ manual_override: { title: true } }) };
    const { ctx, settle } = ctxCollect();
    await app.request(patch({ content: "买书 《算法导论》 花了 199 元" }), undefined, env(note), ctx);
    await settle();
    expect(note.title).toBe("我的书单");
    expect(note.amount).toBe(199);
  });

  it("正文未变（只改 todo_done）：不触发复判，金额不动", async () => {
    const note: Row = { ...BASE };
    const { ctx, settle } = ctxCollect();
    await app.request(patch({ todo_done: true }), undefined, env(note), ctx);
    await settle();
    expect(note.amount).toBe(99);
  });
});
