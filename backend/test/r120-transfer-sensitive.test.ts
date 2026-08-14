import { describe, it, expect } from "vitest";
import { fixTransferMisfile, sanitizeSensitiveTags, demoteEventLog } from "../src/triage";
import { financeStats } from "../src/reports";
import { buildFinanceAggAnswer } from "../src/ask";
import { applyTriage } from "../src/index";
import type { Env, TriageResult, NoteRow } from "../src/types";

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

describe("fixTransferMisfile (R120 P1-3)", () => {
  it("reclassifies withdrawals misfiled as income/expense", () => {
    expect(fixTransferMisfile("微信零钱提现 2000 到银行卡", t("income", { amount: 2000 })).category).toBe("transfer");
    expect(fixTransferMisfile("提现 500", t("expense")).category).toBe("transfer");
  });

  it("reclassifies own-account transfers (转/存到理财/余额宝/银行卡)", () => {
    expect(fixTransferMisfile("转了 5000 到余额宝", t("expense", { amount: 5000 })).category).toBe("transfer");
    expect(fixTransferMisfile("存了 10000 进定期", t("expense")).category).toBe("transfer");
  });

  it("reclassifies borrowing-in misfiled as income (跟/向…借了)", () => {
    expect(fixTransferMisfile("跟老妈借了 3000 周转", t("income", { amount: 3000 })).category).toBe("transfer");
    expect(fixTransferMisfile("向同事借到 500 应急", t("income")).category).toBe("transfer");
  });

  it("keeps real expense/income untouched", () => {
    expect(fixTransferMisfile("还了信用卡 3000", t("expense")).category).toBe("expense");
    expect(fixTransferMisfile("午饭黄焖鸡 23 块", t("expense")).category).toBe("expense");
    expect(fixTransferMisfile("这个月工资发了 15000", t("income")).category).toBe("income");
    // 借给（借出）不是借入，不改判
    expect(fixTransferMisfile("借给小李 1000", t("expense")).category).toBe("expense");
  });

  it("never touches non-finance categories", () => {
    expect(fixTransferMisfile("提现流程文档整理", t("data")).category).toBe("data");
    expect(fixTransferMisfile("记得去银行卡转账", t("todo")).category).toBe("todo");
  });
});

describe("financeStats excludes transfer (R120 P1-3)", () => {
  const note = (category: string, amount: number | null): NoteRow =>
    ({ category, amount, currency: "CNY" }) as unknown as NoteRow;

  it("transfer amounts never pollute expense/income totals", () => {
    const stats = financeStats([note("expense", 100), note("income", 200), note("transfer", 5000)]);
    expect(stats.expenseCount).toBe(1);
    expect(stats.incomeCount).toBe(1);
    expect(stats.transferCount).toBe(1);
    expect(stats.totals.CNY).toEqual({ expense: 100, income: 200 });
  });

  it("transfer-only period reports zero income/expense", () => {
    const stats = financeStats([note("transfer", 2000)]);
    expect(stats.expenseCount + stats.incomeCount).toBe(0);
    expect(stats.totals).toEqual({});
    const answer = buildFinanceAggAnswer(stats, null);
    expect(answer).toContain("资金往来");
    expect(answer).not.toContain("2000");
  });
});

describe("sanitizeSensitiveTags (R120 P1-1)", () => {
  it("drops tags that could carry (parts of) secret values", () => {
    expect(sanitizeSensitiveTags(["密码", "Vp2026@qa-demo", "8642", "门禁"])).toEqual(["密码", "门禁"]);
    expect(sanitizeSensitiveTags(["sk-abc123def", "wifi密码"])).toEqual(["wifi密码"]);
  });

  it("keeps plain topic words", () => {
    expect(sanitizeSensitiveTags(["宽带", "账号", "备忘"])).toEqual(["宽带", "账号", "备忘"]);
  });
});

// 对抗性：AI 派生 title/tags 原样抄入秘密值时，applyTriage 绝不能把它落库
describe("applyTriage never persists secret values in derived fields (R120 P1-1)", () => {
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));
  const SECRET = "P@ssw0rd123";

  function fakeDb(note: Record<string, unknown>) {
    return {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            binds = args;
            return stmt;
          },
          async first() {
            if (sql.includes("FROM notes")) return { ...note };
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            if (sql.startsWith("UPDATE notes SET")) {
              const setPart = sql.slice(0, sql.indexOf(" WHERE "));
              const cols = [...setPart.matchAll(/(\w+) = \?/g)].map((m) => m[1]);
              cols.forEach((col, i) => (note[col] = binds[i]));
            }
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    } as unknown as D1Database;
  }

  it("nulls the AI title and scrubs value-like tags for sensitive notes", async () => {
    const note: Record<string, unknown> = { id: "n1", title: null, tags: "[]", meta: null, is_sensitive: 0 };
    const env = { DB: fakeDb(note), SUINIAN_ENC_KEY: KEY } as unknown as Env;
    const triage: TriageResult = {
      category: "data",
      tags: ["密码", SECRET, "wifi密码"],
      title: `服务器 root 密码是 ${SECRET}`,
      is_sensitive: true,
      todo_due: null,
      amount: null,
      currency: null,
      merchant: null,
    };
    await applyTriage(env, "n1", triage, `服务器 root 密码是 ${SECRET}`);
    expect(note.title).toBeNull();
    expect(String(note.tags)).not.toContain(SECRET);
    expect(note.tags).toBe(JSON.stringify(["密码", "wifi密码"]));
    expect(String(note.content)).not.toContain(SECRET);
  });

  it("keeps normal notes' AI title untouched", async () => {
    const note: Record<string, unknown> = { id: "n2", title: null, tags: "[]", meta: null, is_sensitive: 0 };
    const env = { DB: fakeDb(note), SUINIAN_ENC_KEY: KEY } as unknown as Env;
    const triage: TriageResult = {
      category: "idea",
      tags: ["咖啡"],
      title: "手冲咖啡计划",
      is_sensitive: false,
      todo_due: null,
      amount: null,
      currency: null,
      merchant: null,
    };
    await applyTriage(env, "n2", triage, "周末想试试手冲咖啡");
    expect(note.title).toBe("手冲咖啡计划");
  });
});

describe("demoteEventLog demotes completed decisions (R120 P2)", () => {
  it("选题定了：… is a record, not a todo", () => {
    const r = demoteEventLog("公众号选题定了：只写三篇论文精读", t("todo"));
    expect(r.category).toBe("idea");
  });

  it("future decisions to make stay todo", () => {
    const r = demoteEventLog("明天要把公众号选题定下来", t("todo", { todo_due: "2026-08-15" }));
    expect(r.category).toBe("todo");
  });
});
