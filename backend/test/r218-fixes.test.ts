import { describe, it, expect } from "vitest";
import { fixAdvanceRepayAmount, fixAaReimburse } from "../src/triage";
import { isWhisperHallucination } from "../src/media";
import { applyTriage } from "../src/index";
import type { TriageResult } from "../src/types";

const t = (over: Partial<TriageResult> = {}): TriageResult => ({
  category: "expense",
  tags: [],
  title: "t",
  is_sensitive: false,
  todo_due: null,
  amount: null,
  currency: "CNY",
  merchant: null,
  ...over,
});

// ---- P2-1：垫付×回款同句净额化收口（audit-r217 §1.2）----

describe("R218 P2-1 fixAdvanceRepayAmount", () => {
  it("「我先付 480，其他人回我 360」被净额化成 transfer/120 → expense/480", () => {
    const out = fixAdvanceRepayAmount(
      "我先付了聚餐 480 元，其他人回我 360 元",
      t({ category: "transfer", amount: 120 })
    );
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(480);
  });

  it("AA 垫付变体被反转成 income/120 → expense/480", () => {
    const out = fixAdvanceRepayAmount(
      "聚餐 AA，我先垫付 480 元，其他人收回给我 360 元",
      t({ category: "income", amount: 120 })
    );
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(480);
  });

  it("全额回款「帮同事垫付 300，他微信转我 300」被记 transfer/300 → expense/300", () => {
    const out = fixAdvanceRepayAmount(
      "帮同事垫付门票 300 元，他微信转我 300 元",
      t({ category: "transfer", amount: 300 })
    );
    expect(out.category).toBe("expense");
    expect(out.amount).toBe(300);
  });

  it("模型已按口径给出 expense/垫付总额时原样保留", () => {
    const triage = t({ category: "expense", amount: 480 });
    const out = fixAdvanceRepayAmount("我先付了聚餐 480 元，其他人回我 360 元", triage);
    expect(out).toBe(triage);
  });

  it("追记既往垫付的回款句（收款事件）不收口", () => {
    const triage = t({ category: "income", amount: 360 });
    const out = fixAdvanceRepayAmount("上次垫付的聚餐钱，他今天转我 360 元", triage);
    expect(out).toBe(triage);
  });

  it("明确只付自己那份不收口", () => {
    const triage = t({ category: "expense", amount: 120 });
    const out = fixAdvanceRepayAmount("聚餐我先付了 480，AA 后我只承担自己那份 120，其他人回我 360", triage);
    expect(out).toBe(triage);
  });

  it("回款大于垫付（语义异常）不收口", () => {
    const triage = t({ category: "income", amount: 200 });
    const out = fixAdvanceRepayAmount("我先垫付了 100 元，他转我 300 元", triage);
    expect(out).toBe(triage);
  });

  it("非财务分类不收口", () => {
    const triage = t({ category: "idea" });
    const out = fixAdvanceRepayAmount("我先付了聚餐 480 元，其他人回我 360 元", triage);
    expect(out).toBe(triage);
  });

  it("无回款短语的普通垫付句不触发（交模型主判）", () => {
    const triage = t({ category: "expense", amount: 640 });
    const out = fixAdvanceRepayAmount("部门团建我垫付的 640，人均 160", triage);
    expect(out).toBe(triage);
  });

  it("普通借还/转账句（无垫付语义）不触发", () => {
    const triage = t({ category: "transfer", amount: 500 });
    const out = fixAdvanceRepayAmount("小李还我 500 元借款", triage);
    expect(out).toBe(triage);
  });
});

describe("R218 P2-1 fixAaReimburse 回款动词扩展", () => {
  it("追记既往垫付的「转我」回款判 income（不再 transfer）", () => {
    const out = fixAaReimburse("上次垫付的聚餐钱，同事今天转我 360 元", t({ category: "transfer", amount: 360 }));
    expect(out.category).toBe("income");
  });

  it("既有「AA 收回」行为保留（回归）", () => {
    const out = fixAaReimburse("公司团建 AA 收回 240", t({ category: "transfer", amount: 240 }));
    expect(out.category).toBe("income");
  });

  it("普通借款归还（无 AA/垫付语义）不改判", () => {
    const triage = t({ category: "transfer", amount: 500 });
    const out = fixAaReimburse("小李还我 500 元借款", triage);
    expect(out).toBe(triage);
  });
});

// ---- P2-2：纯噪音幻听已知固定串拦截（audit-r217 §3）----

describe("R218 P2-2 isWhisperHallucination 跨语种幻觉串", () => {
  it("生产实测俄语幻觉串（含尾部省略号/空白）判为幻觉", () => {
    expect(isWhisperHallucination("Продолжение следует...")).toBe(true);
    expect(isWhisperHallucination("Продолжение следует…")).toBe(true);
    expect(isWhisperHallucination("  Продолжение следует  ")).toBe(true);
  });

  it("其它常见跨语种收尾幻觉串判为幻觉", () => {
    expect(isWhisperHallucination("Спасибо за просмотр!")).toBe(true);
    expect(isWhisperHallucination("ご視聴ありがとうございました")).toBe(true);
    expect(isWhisperHallucination("시청해 주셔서 감사합니다")).toBe(true);
    expect(isWhisperHallucination("Don't forget to subscribe!")).toBe(true);
  });

  it("既有英文/中文幻觉串行为保留（回归）", () => {
    expect(isWhisperHallucination("Thank you for watching.")).toBe(true);
    expect(isWhisperHallucination("谢谢大家")).toBe(true);
  });

  it("正常内容不误判（含俄语真实长句）", () => {
    expect(isWhisperHallucination("明天下午三点开会，记得带上季度报表")).toBe(false);
    expect(isWhisperHallucination("продолжение следует 之后我们再讨论下一季度的预算安排和人员分工问题")).toBe(false);
    expect(isWhisperHallucination("继续关注后续发展")).toBe(false);
  });
});

// ---- P2-2：存疑转写禁强副作用（applyTriage 抑制待办/金额）----

type Row = Record<string, unknown>;

function noteRow(over: Row = {}): Row {
  return {
    id: "n1",
    user_id: "u1",
    source: "web",
    raw_type: "voice",
    category: null,
    tags: "[]",
    title: null,
    meta: null,
    is_sensitive: 0,
    todo_due: null,
    todo_done: 0,
    thread_id: null,
    content: "继续关注后续发展",
    content_enc: null,
    created_at: "2026-08-20 00:00:00",
    updated_at: "2026-08-20 00:00:00",
    deleted_at: null,
    ...over,
  };
}

function fakeDb(notes: Row[]) {
  return {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM notes")) return notes.find((n) => n.id === binds[0]) ?? null;
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET")) {
            const whereIdx = sql.indexOf(" WHERE ");
            const setPart = sql.slice(0, whereIdx);
            const cols = [...setPart.matchAll(/(\w+) = (?:coalesce\(\w+, )?\?/g)].map((m) => m[1]);
            const whereBinds = binds.slice(cols.length) as string[];
            const targets = notes.filter((n) => n.id === whereBinds[0]);
            for (const note of targets) cols.forEach((col, i) => (note[col] = binds[i]));
            return { meta: { changes: targets.length } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
}

describe("R218 P2-2 applyTriage 存疑转写抑制强副作用", () => {
  it("transcript_suspect 笔记：todo 降级 idea，todo_due/amount 置空", async () => {
    const notes = [noteRow({ meta: JSON.stringify({ transcript_suspect: true }) })];
    await applyTriage(
      { DB: fakeDb(notes) },
      "n1",
      t({ category: "todo", todo_due: "2026-08-21", amount: 100 }),
      "继续关注后续发展"
    );
    expect(notes[0].category).toBe("idea");
    expect(notes[0].todo_due).toBe(null);
    expect(notes[0].amount).toBe(null);
  });

  it("transcript_suspect 笔记：财务分类金额置空（不凭空入账）", async () => {
    const notes = [noteRow({ meta: JSON.stringify({ transcript_suspect: true }) })];
    await applyTriage({ DB: fakeDb(notes) }, "n1", t({ category: "expense", amount: 480 }), "继续关注后续发展");
    expect(notes[0].category).toBe("expense");
    expect(notes[0].amount).toBe(null);
  });

  it("无 suspect 标记的语音笔记行为不变（回归）", async () => {
    const notes = [noteRow()];
    await applyTriage(
      { DB: fakeDb(notes) },
      "n1",
      t({ category: "todo", todo_due: "2026-08-21" }),
      "继续关注后续发展"
    );
    expect(notes[0].category).toBe("todo");
    expect(notes[0].todo_due).toBe("2026-08-21");
  });
});
