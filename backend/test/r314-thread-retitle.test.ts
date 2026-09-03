// R314 P1-4（audit-r313 §0.2-7）：线索标题回填——重建 summarize 阶段模型失败的线索按轮补跑，
// 10 分钟 cron 对残留「未命名线索」兜底补标题。
import { describe, it, expect, vi, beforeEach } from "vitest";

const ai = vi.hoisted(() => ({
  chatComplete: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
}));
vi.mock("../src/ai", () => ({ chatComplete: (...args: unknown[]) => ai.chatComplete(...args) }));
vi.mock("../src/guard-events", () => ({
  recordOutletFoldMarks: () => {},
  recordOutletVerbatimClosed: () => {},
}));

import {
  summarizeThread,
  rebuildStep,
  retitleUntitledThreads,
  newRebuildState,
  UNTITLED_THREAD,
  SUMMARIZE_RETRY_ROUNDS,
} from "../src/threads";
import type { Env } from "../src/types";

interface FakeThread {
  id: string;
  user_id: string;
  title: string;
  summary: string | null;
  note_count: number;
  stale: boolean;
}

function fakeEnv(threads: FakeThread[], notesByThread: Record<string, string[]>, activeJobUsers: string[] = []) {
  const threadMap = new Map(threads.map((t) => [t.id, { ...t }]));
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async all() {
          if (sql.includes("FROM notes WHERE thread_id = ? ORDER BY created_at")) {
            const rows = (notesByThread[binds[0] as string] ?? []).map((c, i) => ({
              title: null,
              content: c,
              meta: null,
              created_at: `2026-08-0${i + 1} 10:00:00`,
            }));
            return { results: rows };
          }
          if (sql.includes("SELECT id FROM threads WHERE user_id = ? AND note_count > 0 AND id > ?")) {
            return {
              results: [...threadMap.values()]
                .filter((t) => t.user_id === binds[0] && t.note_count > 0 && t.id > (binds[1] as string))
                .sort((a, b) => (a.id < b.id ? -1 : 1))
                .slice(0, 10)
                .map((t) => ({ id: t.id })),
            };
          }
          if (sql.includes("SELECT id, title FROM threads") && sql.includes("WHERE title = ?")) {
            return {
              results: [...threadMap.values()]
                .filter((t) => t.title === binds[0] && t.note_count > 0 && t.stale && !activeJobUsers.includes(t.user_id))
                .slice(0, binds[1] as number)
                .map((t) => ({ id: t.id, title: t.title })),
            };
          }
          if (sql.includes("FROM threads t WHERE t.user_id")) return { results: [] }; // mergeDuplicateThreads
          throw new Error(`unexpected all(): ${sql}`);
        },
        async first() {
          if (sql.includes("COUNT(*) AS c FROM threads WHERE user_id")) {
            return { c: [...threadMap.values()].filter((t) => t.user_id === binds[0] && t.note_count > 0).length };
          }
          if (sql.startsWith("SELECT title FROM threads WHERE id")) {
            const t = threadMap.get(binds[0] as string);
            return t ? { title: t.title } : null;
          }
          throw new Error(`unexpected first(): ${sql}`);
        },
        async run() {
          if (sql.startsWith("UPDATE threads SET title = ?, summary = ?")) {
            const t = threadMap.get(binds[2] as string);
            if (t) {
              t.title = binds[0] as string;
              t.summary = binds[1] as string | null;
              t.stale = false;
            }
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith("UPDATE threads SET updated_at")) {
            const t = threadMap.get(binds[0] as string);
            if (t) t.stale = false;
            return { meta: { changes: 1 } };
          }
          throw new Error(`unexpected run(): ${sql}`);
        },
      };
      return stmt;
    },
  };
  return { env: { DB: db } as unknown as Env, threadMap };
}

const NOTES = {
  t1: ["周报想做成语音播报", "语音播报用 TTS 试一下"],
  t2: ["季度复盘做成 PPT", "PPT 重点放转化率"],
  t3: ["读书笔记方法论", "卡片盒笔记法实践"],
};
const good = (title: string) => JSON.stringify({ title, summary: `${title}的脉络` });

beforeEach(() => ai.chatComplete.mockReset());

describe("summarizeThread 返回值", () => {
  it("模型无输出 / 非 JSON / 抛错 ⇒ failed；无笔记 ⇒ empty；成功 ⇒ ok 并落库", async () => {
    const { env, threadMap } = fakeEnv(
      [{ id: "t1", user_id: "u1", title: UNTITLED_THREAD, summary: null, note_count: 2, stale: true }],
      NOTES
    );
    ai.chatComplete.mockResolvedValueOnce(null);
    expect(await summarizeThread(env, "t1")).toBe("failed");
    ai.chatComplete.mockResolvedValueOnce("抱歉，无法生成");
    expect(await summarizeThread(env, "t1")).toBe("failed");
    ai.chatComplete.mockRejectedValueOnce(new Error("timeout"));
    expect(await summarizeThread(env, "t1")).toBe("failed");
    expect(threadMap.get("t1")!.title).toBe(UNTITLED_THREAD);
    expect(await summarizeThread(env, "t_none")).toBe("empty");
    ai.chatComplete.mockResolvedValueOnce(good("语音播报周报"));
    expect(await summarizeThread(env, "t1")).toBe("ok");
    expect(threadMap.get("t1")!.title).toBe("语音播报周报");
  });
});

describe("rebuild summarize 阶段补跑", () => {
  it("主扫描失败的线索进入 summarize_retry，下一轮成功 ⇒ 全部有标题后才 done", async () => {
    const { env, threadMap } = fakeEnv(
      ["t1", "t2", "t3"].map((id) => ({ id, user_id: "u1", title: UNTITLED_THREAD, summary: null, note_count: 2, stale: true })),
      NOTES
    );
    // 首轮：t1 ok，t2 超时(null)，t3 ok；补跑轮：t2 ok
    ai.chatComplete
      .mockResolvedValueOnce(good("语音播报周报"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(good("读书方法"))
      .mockResolvedValueOnce(good("季度复盘 PPT"));
    const state = newRebuildState();
    state.phase = "summarize";
    let s = state;
    const phases: string[] = [];
    for (let i = 0; i < 20 && s.phase !== "done"; i++) {
      s = await rebuildStep(env, "u1", s, Date.now() + 5_000);
      phases.push(s.phase);
    }
    expect(s.phase).toBe("done");
    expect(phases).toContain("summarize_retry");
    expect([...threadMap.values()].map((t) => t.title).sort()).toEqual(["季度复盘 PPT", "读书方法", "语音播报周报"].sort());
    expect(ai.chatComplete).toHaveBeenCalledTimes(4);
    expect(s.summarizeRetry ?? []).toEqual([]);
  });

  it("补跑轮数封顶（SUMMARIZE_RETRY_ROUNDS），持续失败的线索留给 cron 兜底而不是卡住重建", async () => {
    const { env, threadMap } = fakeEnv(
      [{ id: "t2", user_id: "u1", title: UNTITLED_THREAD, summary: null, note_count: 2, stale: true }],
      NOTES
    );
    ai.chatComplete.mockResolvedValue(null);
    const state = newRebuildState();
    state.phase = "summarize";
    let s = state;
    for (let i = 0; i < 20 && s.phase !== "done"; i++) s = await rebuildStep(env, "u1", s, Date.now() + 5_000);
    expect(s.phase).toBe("done");
    expect(ai.chatComplete).toHaveBeenCalledTimes(1 + SUMMARIZE_RETRY_ROUNDS);
    expect(threadMap.get("t2")!.title).toBe(UNTITLED_THREAD);
  });

  it("补跑队列跨 slice 续跑：deadline 中断后状态可恢复并继续", async () => {
    const { env, threadMap } = fakeEnv(
      ["t1", "t2"].map((id) => ({ id, user_id: "u1", title: UNTITLED_THREAD, summary: null, note_count: 2, stale: true })),
      NOTES
    );
    ai.chatComplete
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(good("语音播报周报"))
      .mockResolvedValueOnce(good("季度复盘 PPT"));
    let s = newRebuildState();
    s.phase = "summarize";
    // 每个 slice 只给极短 deadline：每步最多前进一条
    for (let i = 0; i < 40 && s.phase !== "done"; i++) {
      s = JSON.parse(JSON.stringify(await rebuildStep(env, "u1", s, Date.now() + 1)));
    }
    expect(s.phase).toBe("done");
    expect([...threadMap.values()].every((t) => t.title !== UNTITLED_THREAD)).toBe(true);
  });
});

describe("retitleUntitledThreads（10 分钟 cron 兜底）", () => {
  it("只补 3 分钟内未更新过的未命名线索，跳过有活动重建任务的用户；成功计 titled", async () => {
    const { env, threadMap } = fakeEnv(
      [
        { id: "t1", user_id: "u1", title: UNTITLED_THREAD, summary: null, note_count: 2, stale: true },
        { id: "t2", user_id: "u1", title: UNTITLED_THREAD, summary: null, note_count: 2, stale: false }, // 刚更新过
        { id: "t3", user_id: "u2", title: UNTITLED_THREAD, summary: null, note_count: 2, stale: true }, // u2 在重建
        { id: "t4", user_id: "u1", title: "已有标题", summary: null, note_count: 2, stale: true },
      ],
      NOTES,
      ["u2"]
    );
    ai.chatComplete.mockResolvedValueOnce(good("语音播报周报"));
    const r = await retitleUntitledThreads(env);
    expect(r).toEqual({ scanned: 1, titled: 1 });
    expect(threadMap.get("t1")!.title).toBe("语音播报周报");
    expect(threadMap.get("t2")!.title).toBe(UNTITLED_THREAD);
    expect(threadMap.get("t3")!.title).toBe(UNTITLED_THREAD);
  });

  it("失败的线索刷新 updated_at 让出名额，下一轮再试；标题命中原文回落未命名不计 titled", async () => {
    const { env, threadMap } = fakeEnv(
      [
        { id: "t1", user_id: "u1", title: UNTITLED_THREAD, summary: null, note_count: 2, stale: true },
        { id: "t2", user_id: "u1", title: UNTITLED_THREAD, summary: null, note_count: 2, stale: true },
      ],
      NOTES
    );
    ai.chatComplete
      .mockResolvedValueOnce(null)
      // 标题逐字照抄成员笔记 ⇒ 聚合层命中 ⇒ 回落未命名（安全断言不变）
      .mockResolvedValueOnce(JSON.stringify({ title: "季度复盘做成 PPT", summary: "x" }));
    const r = await retitleUntitledThreads(env);
    expect(r.scanned).toBe(2);
    expect(r.titled).toBe(0);
    expect(threadMap.get("t1")!.stale).toBe(false);
    expect(threadMap.get("t2")!.title).toBe(UNTITLED_THREAD);
    // 第二轮：t1 不再 stale ⇒ 本轮不扫（不热循环）
    ai.chatComplete.mockResolvedValue(good("x"));
    const r2 = await retitleUntitledThreads(env);
    expect(r2.scanned).toBe(0);
  });
});
