import { describe, it, expect, vi } from "vitest";
import { buildTriagePrompt, applyTriageFixes } from "../src/triage";
import { deleteMediaObjects, flushMediaDeleteFailures } from "../src/media";
import type { TriageResult } from "../src/types";
import type { Env } from "../src/types";

const NOW = new Date("2026-08-21T12:00:00+08:00");
const TZ = "Asia/Shanghai";

function t(category: TriageResult["category"], extra: Partial<TriageResult> = {}): TriageResult {
  return {
    category,
    tags: [],
    title: "t",
    is_sensitive: false,
    todo_due: null,
    amount: null,
    currency: null,
    merchant: null,
    ...extra,
  };
}

// ---- P2（audit-r225 §2）：欠款/未收回/待还句式 few-shot 回流提示词 ----
describe("R226 P2 debt/outstanding few-shot in triage prompt", () => {
  const prompt = buildTriagePrompt(NOW, [], TZ);
  it("includes the audited 垫付未收回 sentence as a transfer judgement", () => {
    expect(prompt).toContain("垫付的 300 块房费小王一直没给我");
    expect(prompt).toContain("欠款/未收回/待还句式");
  });
  it("includes 还欠我 / 借出未还 / 自己欠别人 variants", () => {
    expect(prompt).toContain("小李还欠我 500 一直没还");
    expect(prompt).toContain("上月借给同事 800 还没还我");
    expect(prompt).toContain("我还欠小陈 200 没还他");
  });
});

// 未回款守卫扩展：「一直没给我」「没结」等挂账句式绝不能被垫付回款链翻成 income
describe("R226 pending-repayment guard covers 没给/没结", () => {
  it("垫付的 300 块房费小王一直没给我 stays transfer", () => {
    const r = applyTriageFixes("垫付的 300 块房费小王一直没给我", t("transfer", { amount: 300 }), NOW, TZ);
    expect(r.category).toBe("transfer");
    expect(r.amount).toBe(300);
  });
  it("帮部门垫付的 450 材料费到现在没结 stays transfer", () => {
    const r = applyTriageFixes("帮部门垫付的 450 材料费到现在没结", t("transfer", { amount: 450 }), NOW, TZ);
    expect(r.category).toBe("transfer");
    expect(r.amount).toBe(450);
  });
  it("existing repay flows still flip (R220 回归)", () => {
    const r = applyTriageFixes("昨天垫付的地铁卡 200，今天他还我 200", t("transfer", { amount: 200 }), NOW, TZ);
    expect(r.category).toBe("income");
  });
});

// ---- P1（audit-r225 §3c）：R2 级联删除失败不再静默 ----
type Row = { r2_key: string; attempts: number; last_error: string | null };

function fakeEnv(
  deleteImpl: (keys: string[]) => Promise<void>,
  headImpl: (key: string) => Promise<object | null> = async () => null
) {
  const rows = new Map<string, Row>();
  const db = {
    prepare(sql: string) {
      return {
        async run() {
          exec(sql, []);
          return { success: true };
        },
        async all() {
          return { results: exec(sql, []) };
        },
        bind(...args: unknown[]) {
          return {
            sql,
            args,
            async run() {
              exec(sql, args);
              return { success: true };
            },
            async all() {
              return { results: exec(sql, args) };
            },
          };
        },
      };
    },
    async batch(stmts: { sql: string; args: unknown[]; run: () => Promise<unknown> }[]) {
      for (const s of stmts) await s.run();
      return [];
    },
  };
  function exec(sql: string, args: unknown[]): Row[] {
    if (sql.startsWith("INSERT INTO media_delete_failures")) {
      const [key, err] = args as [string, string];
      const prev = rows.get(key);
      if (prev) rows.set(key, { ...prev, attempts: prev.attempts + 1, last_error: err });
      else rows.set(key, { r2_key: key, attempts: 1, last_error: err });
      return [];
    }
    if (sql.startsWith("SELECT r2_key FROM media_delete_failures")) {
      return [...rows.values()];
    }
    if (sql.startsWith("UPDATE media_delete_failures")) {
      const [err, ...keys] = args as [string, ...string[]];
      for (const k of keys) {
        const prev = rows.get(k);
        if (prev) rows.set(k, { ...prev, attempts: prev.attempts + 1, last_error: err });
      }
      return [];
    }
    if (sql.startsWith("DELETE FROM media_delete_failures")) {
      for (const k of args as string[]) rows.delete(k);
      return [];
    }
    throw new Error(`unexpected sql: ${sql}`);
  }
  const media = { delete: vi.fn(deleteImpl), head: vi.fn(headImpl) };
  return { env: { MEDIA: media, DB: db } as unknown as Pick<Env, "MEDIA" | "DB">, rows, media };
}

describe("R226 P1 deleteMediaObjects retry + failure recording", () => {
  it("success path deletes once, records nothing", async () => {
    const { env, rows, media } = fakeEnv(async () => {});
    await deleteMediaObjects(env, ["a", "b"]);
    expect(media.delete).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(0);
  });

  it("first failure retries once and succeeds without recording", async () => {
    let calls = 0;
    const { env, rows, media } = fakeEnv(async () => {
      if (++calls === 1) throw new Error("r2 down");
    });
    await deleteMediaObjects(env, ["a"]);
    expect(media.delete).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(0);
  });

  it("double failure records every key with the error", async () => {
    const { env, rows } = fakeEnv(async () => {
      throw new Error("r2 down hard");
    });
    await deleteMediaObjects(env, ["k1", "k2"]);
    expect(rows.size).toBe(2);
    expect(rows.get("k1")?.last_error).toContain("r2 down hard");
  });

  // R228 P1：delete 不抛错不等于删净——逐 key head 复核，幸存对象记入 failures 表
  it("silent delete failure (no throw, object survives) is recorded via head verify", async () => {
    const { env, rows, media } = fakeEnv(
      async () => {},
      async (key) => (key === "stuck.png" ? {} : null)
    );
    await deleteMediaObjects(env, ["stuck.png", "gone.txt"]);
    // 2 次首轮逐 key 复核 + 1 次幸存对象就地重删后的再复核（R262）
    expect(media.head).toHaveBeenCalledTimes(3);
    expect(media.delete).toHaveBeenCalledWith(["stuck.png"]);
    expect(rows.size).toBe(1);
    expect(rows.get("stuck.png")?.last_error).toContain("still present");
  });

  it("no MEDIA binding or empty keys is a no-op", async () => {
    const { env, media } = fakeEnv(async () => {});
    await deleteMediaObjects(env, []);
    expect(media.delete).not.toHaveBeenCalled();
    await deleteMediaObjects({ DB: env.DB } as Pick<Env, "MEDIA" | "DB">, ["x"]);
  });
});

describe("R226 P1 flushMediaDeleteFailures cron retry", () => {
  it("clears rows only after a confirmed successful delete", async () => {
    const { env, rows } = fakeEnv(async () => {
      throw new Error("still down");
    });
    await deleteMediaObjects(env, ["k1"]);
    await deleteMediaObjects(env, ["k1"]);
    expect(rows.get("k1")?.attempts).toBe(2);

    // still failing: attempts increment, row stays
    expect(await flushMediaDeleteFailures(env)).toBe(0);
    expect(rows.get("k1")?.attempts).toBe(3);

    // recovered: row cleared
    (env.MEDIA as unknown as { delete: ReturnType<typeof vi.fn> }).delete.mockImplementation(async () => {});
    expect(await flushMediaDeleteFailures(env)).toBe(1);
    expect(rows.size).toBe(0);
  });

  // R228 P1：cron flush 同样只清除 head 复核确认删净的行
  it("flush keeps rows whose objects silently survive delete", async () => {
    let stuck = true;
    const { env, rows } = fakeEnv(
      async () => {},
      async (key) => (key === "stuck.png" && stuck ? {} : null)
    );
    await deleteMediaObjects(env, ["stuck.png"]);
    expect(rows.size).toBe(1);

    // delete 成功返回但对象仍在：行保留，attempts 递增
    expect(await flushMediaDeleteFailures(env)).toBe(0);
    expect(rows.get("stuck.png")?.attempts).toBe(2);

    // 对象真正消失后：行清除
    stuck = false;
    expect(await flushMediaDeleteFailures(env)).toBe(1);
    expect(rows.size).toBe(0);
  });

  it("empty queue is a cheap no-op", async () => {
    const { env, media } = fakeEnv(async () => {});
    expect(await flushMediaDeleteFailures(env)).toBe(0);
    expect(media.delete).not.toHaveBeenCalled();
  });
});
