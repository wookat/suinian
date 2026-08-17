import { describe, it, expect } from "vitest";
import { financeListIntent, buildFinanceListAnswer, parseTimeRange } from "../src/ask";
import { parseTriageJson } from "../src/triage";
import { decodeTextBytes, looksBinaryText, buildFileNote, buildFileReply, FILE_BINARY_PLACEHOLDER } from "../src/files";
import { generateDailyReviewDetailed } from "../src/review";
import type { Env, NoteRow } from "../src/types";

// ---- P1-1: 时间窗财务列举意图 ----

describe("financeListIntent (R170 P1-1)", () => {
  it("recognizes expense enumeration phrasings (q08 variants)", () => {
    expect(financeListIntent("最近一周我花了哪些钱")).toBe("expense");
    expect(financeListIntent("最近一周我有哪些支出")).toBe("expense");
    expect(financeListIntent("过去7天我的消费明细")).toBe("expense");
    expect(financeListIntent("最近一周我的钱都花在哪了")).toBe("expense");
    expect(financeListIntent("这个月的开销都有哪些")).toBe("expense");
    expect(financeListIntent("列一下上个月的支出")).toBe("expense");
  });
  it("recognizes income and mixed enumeration", () => {
    expect(financeListIntent("最近一个月我有哪些收入")).toBe("income");
    expect(financeListIntent("这个月赚了哪些钱")).toBe("income");
    expect(financeListIntent("最近记了哪些账")).toBe("both");
    expect(financeListIntent("这个月的收支明细")).toBe("both");
  });
  it("does not hijack aggregates, single items, or non-finance", () => {
    // 聚合类走 financeAggIntent 精确合计路由
    expect(financeListIntent("这个月一共花了多少钱")).toBeNull();
    // 具体单笔走召回
    expect(financeListIntent("买机械键盘的支出有哪些细节")).toBeNull();
    expect(financeListIntent("我在星巴克花了哪些钱办会员")).toBeNull();
    // 非财务
    expect(financeListIntent("最近一周我记了哪些想法")).toBeNull();
    expect(financeListIntent("这几天有什么要办的事")).toBeNull();
  });
  it("time window parses for the enumeration phrasings", () => {
    expect(parseTimeRange("最近一周我花了哪些钱")).not.toBeNull();
    expect(parseTimeRange("过去7天我的消费明细")).not.toBeNull();
  });
});

describe("buildFinanceListAnswer (R170 P1-1)", () => {
  const row = (over: Partial<NoteRow>): NoteRow =>
    ({
      id: "n1",
      title: "买咖啡",
      content: "买了杯咖啡 30 元",
      created_at: "2026-08-10 03:00:00",
      category: "expense",
      is_sensitive: 0,
      amount: 30,
      currency: "CNY",
      ...over,
    }) as unknown as NoteRow;

  it("lists rows with per-currency totals and caliber note", () => {
    const md = buildFinanceListAnswer(
      "expense",
      [row({}), row({ id: "n2", title: "猫打疫苗", amount: 260 })],
      "最近一周"
    );
    expect(md).toContain("最近一周");
    expect(md).toContain("2 笔支出");
    expect(md).toContain("¥290");
    expect(md).toContain("数据库精确列举");
    expect(md).toContain("待办等尚未发生的计划不计入");
  });
  it("fails closed on empty window instead of citing out-of-window notes", () => {
    const md = buildFinanceListAnswer("income", [], "最近一周");
    expect(md).toContain("没有找到");
    expect(md).toContain("不引用时间范围之外的笔记");
  });
  it("counts sensitive rows in totals without exposing them", () => {
    const md = buildFinanceListAnswer("expense", [row({}), row({ id: "s1", is_sensitive: 1, amount: 100 })], null);
    expect(md).toContain("¥130");
    expect(md).toContain("1 笔加密的敏感记录");
    expect(md.split("逐笔明细")[1]).not.toContain("s1");
  });
  it("reports unknown-amount rows separately", () => {
    const md = buildFinanceListAnswer("expense", [row({}), row({ id: "n3", amount: null, currency: null })], null);
    expect(md).toContain("¥30");
    expect(md).toContain("1 笔未识别出金额");
  });
});

// ---- P1-2: parseTriageJson 健壮化 ----

describe("parseTriageJson robustness (R170 P1-2)", () => {
  const obj = (amount: number, extra = "") =>
    `{"category":"expense","tags":["餐饮"],"title":"账单行","is_sensitive":false,"todo_due":null,"amount":${amount},"currency":"CNY"${extra}}`;

  it("still parses a single clean object", () => {
    const r = parseTriageJson(obj(12.5));
    expect(r?.category).toBe("expense");
    expect(r?.amount).toBe(12.5);
  });
  it("tolerates multiple adjacent objects and sums uniform finance rows", () => {
    const r = parseTriageJson(`${obj(10)}\n${obj(20.5)}\n${obj(3)}`);
    expect(r?.category).toBe("expense");
    expect(r?.amount).toBe(33.5);
    expect(r?.currency).toBe("CNY");
  });
  it("tolerates comma-separated objects and bare arrays", () => {
    expect(parseTriageJson(`${obj(10)},${obj(5)}`)?.amount).toBe(15);
    expect(parseTriageJson(`[${obj(1)},${obj(2)}]`)?.amount).toBe(3);
  });
  it("tolerates markdown fences and surrounding prose", () => {
    const fenced = "以下是分拣结果：\n```json\n" + obj(7) + "\n" + obj(8) + "\n```\n完毕。";
    expect(parseTriageJson(fenced)?.amount).toBe(15);
    const prose = `好的，这条笔记我分析如下。${obj(9)} 希望对你有帮助！`;
    expect(parseTriageJson(prose)?.amount).toBe(9);
  });
  it("keeps braces inside string values intact", () => {
    const r = parseTriageJson(`{"category":"idea","tags":[],"title":"含{花括号}和\\"引号\\"","is_sensitive":false,"todo_due":null,"amount":null,"currency":null}`);
    expect(r?.title).toContain("{花括号}");
  });
  it("nulls the amount when mixed categories cannot be reconciled", () => {
    const income = `{"category":"income","tags":[],"title":"","is_sensitive":false,"todo_due":null,"amount":50,"currency":"CNY"}`;
    const r = parseTriageJson(`${obj(10)}\n${income}`);
    expect(r?.category).toBe("expense");
    expect(r?.amount).toBeNull();
  });
  it("skips malformed fragments and invalid categories", () => {
    expect(parseTriageJson(`{"category":"nonsense"} ${obj(4)}`)?.amount).toBe(4);
    expect(parseTriageJson("{broken json} not json at all")).toBeNull();
    expect(parseTriageJson("")).toBeNull();
  });
});

// ---- P2-1: Big5 解码 ----

describe("decodeTextBytes Big5 (R170 P2-1)", () => {
  it("decodes Big5 CSV bytes correctly instead of GBK mojibake", () => {
    // 「統一發票報帳，計程車資三百五十元」的 Big5 编码
    const big5 = new Uint8Array([
      178, 206, 164, 64, 181, 111, 178, 188, 179, 248, 177, 98, 161, 65, 173, 112,
      181, 123, 168, 174, 184, 234, 164, 84, 166, 202, 164, 173, 164, 81, 164, 184,
    ]);
    expect(decodeTextBytes(big5)).toBe("統一發票報帳，計程車資三百五十元");
  });
  it("still decodes GBK bytes correctly", () => {
    // 「日期,项目,金额」的 GBK 编码
    const gbk = new Uint8Array([200, 213, 198, 218, 44, 207, 238, 196, 191, 44, 189, 240, 182, 238]);
    expect(decodeTextBytes(gbk)).toBe("日期,项目,金额");
  });
  it("keeps UTF-8 fast path", () => {
    expect(decodeTextBytes(new TextEncoder().encode("普通 UTF-8 文本"))).toBe("普通 UTF-8 文本");
  });
});

// ---- P2-2: 二进制伪装文本扩展名 ----

describe("binary masquerade detection (R170 P2-2)", () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  it("flags PNG/NUL-laden bytes and passes real text", () => {
    expect(looksBinaryText(pngBytes)).toBe(true);
    expect(looksBinaryText(new Uint8Array([65, 66, 0, 67]))).toBe(true);
    expect(looksBinaryText(new TextEncoder().encode("date,item,amount\n2026-08-01,咖啡,30"))).toBe(false);
    // UTF-16 BOM 文本不是二进制
    expect(looksBinaryText(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
  });

  it("buildFileNote rejects binary .csv with the dedicated placeholder", async () => {
    const note = await buildFileNote({} as unknown as Env, "csv", "账单.csv", pngBytes);
    expect(note.extracted).toBe(false);
    expect(note.content).toContain(FILE_BINARY_PLACEHOLDER);
  });

  it("buildFileReply explains the masquerade instead of a generic failure", () => {
    const reply = buildFileReply("账单.csv", `${FILE_BINARY_PLACEHOLDER}：账单.csv`, false);
    expect(reply).toContain("二进制数据");
    expect(reply).toContain("原件已保存");
    expect(buildFileReply("a.txt", "【文件】文本提取失败，已存档原件：a.txt", false)).toContain("文本提取失败");
  });
});

// ---- P2-4: 每日回顾洞察配额 ----

describe("daily review insight quota (R170 P2-4)", () => {
  const note = (id: string, category = "idea"): NoteRow =>
    ({
      id,
      user_id: "u1",
      source: "web",
      raw_type: "text",
      content: `内容足够长的一条笔记 ${id}`,
      url: null,
      title: null,
      category,
      tags: "[]",
      todo_due: "2026-01-02",
      todo_done: 0,
      is_sensitive: 0,
      meta: null,
      created_at: "2025-01-01 00:00:00",
      updated_at: "2025-01-01 00:00:00",
    }) as unknown as NoteRow;

  /** 纪念日素材充足（year/month 各 2 条）+ 一条临期待办的 fake D1。 */
  function fakeEnv() {
    const inserted: unknown[][] = [];
    let anniv = 0;
    const DB = {
      prepare(sql: string) {
        let binds: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            binds = args;
            return stmt;
          },
          async first() {
            if (sql.includes("COUNT(*) AS n FROM daily_reviews")) return { n: 0 };
            if (sql.includes("category = 'todo'")) return note("todo-due", "todo");
            return null;
          },
          async all() {
            if (sql.includes("datetime(created_at, ?) >=")) {
              anniv++;
              return { results: [note(`a${anniv}-1`), note(`a${anniv}-2`)].slice(0, binds[binds.length - 1] as number) };
            }
            return { results: [] };
          },
          async run() {
            if (sql.includes("INSERT INTO daily_reviews")) inserted.push(binds);
            return { meta: { changes: 1 } };
          },
        };
        return stmt;
      },
    };
    return { env: { DB, DEEPSEEK_API_KEY: "" } as unknown as Env, inserted };
  }

  it("reserves one slot for the pending todo even with plentiful anniversaries", async () => {
    const { env, inserted } = fakeEnv();
    const res = await generateDailyReviewDetailed(env, "u1");
    expect(res.count).toBe(3);
    const kinds = inserted.map((b) => b[4]);
    expect(kinds).toContain("pending_todo");
    expect(kinds.filter((k) => k === "year_ago" || k === "month_ago").length).toBe(2);
  });
});
