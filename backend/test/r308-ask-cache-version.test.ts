import { describe, it, expect } from "vitest";
import { askUserDataVersion } from "../src/index";

// R308 P1-2（audit-r307 §8）：Ask 答案缓存键纳入用户资料版本——新增/编辑/删除/
// 恢复任一发生，版本串必须翻转；查询失败返回 null（调用方按不可缓存处理）。
function dbWith(row: { total: number; live: number | null; u: string | null } | null, fail = false) {
  return {
    prepare(sql: string) {
      const stmt = {
        bind() {
          return stmt;
        },
        async first() {
          if (fail) throw new Error("d1 down");
          expect(sql).toMatch(/FROM notes WHERE user_id = \?/);
          return row;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

describe("R308 P1-2 askUserDataVersion", () => {
  it("写入新笔记后版本翻转（COUNT 与 MAX(updated_at) 任一变化即不同）", async () => {
    const v0 = await askUserDataVersion(dbWith({ total: 3, live: 3, u: "2026-09-02 10:00:00" }), "u1");
    const v1 = await askUserDataVersion(dbWith({ total: 4, live: 4, u: "2026-09-02 10:00:01" }), "u1");
    const v2 = await askUserDataVersion(dbWith({ total: 4, live: 4, u: "2026-09-02 10:00:02" }), "u1");
    expect(v0).not.toBe(v1);
    expect(v1).not.toBe(v2);
  });

  it("软删（total 不变、live 减一、updated_at 前进）同样翻转；硬删仅 total 变化也翻转", async () => {
    const base = await askUserDataVersion(dbWith({ total: 4, live: 4, u: "2026-09-02 10:00:00" }), "u1");
    const soft = await askUserDataVersion(dbWith({ total: 4, live: 3, u: "2026-09-02 10:00:05" }), "u1");
    const hard = await askUserDataVersion(dbWith({ total: 3, live: 3, u: "2026-09-02 10:00:00" }), "u1");
    expect(soft).not.toBe(base);
    expect(hard).not.toBe(base);
  });

  it("空账号与查询失败：空账号有稳定版本，失败返回 null", async () => {
    expect(await askUserDataVersion(dbWith({ total: 0, live: null, u: null }), "u1")).toBe("0|0|");
    expect(await askUserDataVersion(dbWith(null), "u1")).toBeNull();
    expect(await askUserDataVersion(dbWith({ total: 1, live: 1, u: "x" }, true), "u1")).toBeNull();
  });
});
