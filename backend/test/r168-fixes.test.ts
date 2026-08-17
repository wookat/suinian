import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { app } from "../src/index";
import { sha256Hex } from "../src/auth";
import {
  financeCompareIntent,
  financeMomIntent,
  buildFinanceCompareAnswer,
  buildFinanceMomAnswer,
  financeAggIntent,
  topicCountIntent,
} from "../src/ask";
import { financeStats, type FinanceStats } from "../src/reports";
import { sniffFileKind, detectFileKind, decodeTextBytes, extractFileText } from "../src/files";
import type { NoteRow } from "../src/types";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// ---- P1: 财务比较类意图识别 ----

describe("financeCompareIntent (R168 P1)", () => {
  it("recognizes 赚/花 comparison phrasings", () => {
    expect(financeCompareIntent("这个月我是赚得多还是花得多")).toBe(true);
    expect(financeCompareIntent("我花得多还是赚得多")).toBe(true);
    expect(financeCompareIntent("本月收入多还是支出多")).toBe(true);
    expect(financeCompareIntent("我是不是花得比挣得多")).toBe(true);
  });
  it("recognizes fixed balance idioms", () => {
    expect(financeCompareIntent("这个月我入不敷出了吗")).toBe(true);
    expect(financeCompareIntent("这个月超支了吗")).toBe(true);
    expect(financeCompareIntent("本月是赚了还是亏了")).toBe(true);
  });
  it("recognizes difference phrasings", () => {
    expect(financeCompareIntent("这个月收支差了多少")).toBe(true);
    expect(financeCompareIntent("收入和支出差多少")).toBe(true);
    expect(financeCompareIntent("收入跟支出哪个多")).toBe(true);
  });
  it("does not hijack single-item or plain aggregate questions", () => {
    expect(financeCompareIntent("买机械键盘花了多少钱")).toBe(false);
    expect(financeCompareIntent("这个月一共花了多少钱")).toBe(false);
    expect(financeCompareIntent("上个月结余多少钱")).toBe(false);
    // fact queries stay on recall so the notes themselves answer
    expect(financeCompareIntent("花得最多的那笔是什么")).toBe(false);
  });
  it("plain aggregates still reach the exact aggregate route", () => {
    expect(financeAggIntent("这个月一共花了多少钱")).toBe("exact");
  });
});

describe("financeMomIntent (R168 P1)", () => {
  it("recognizes month-over-month phrasings", () => {
    expect(financeMomIntent("这个月开销环比怎么样")).toBe("month");
    expect(financeMomIntent("这个月比上个月花得多吗")).toBe("month");
    expect(financeMomIntent("比上个月多花了多少")).toBe("month");
    expect(financeMomIntent("这个月和上个月的支出对比一下")).toBe("month");
  });
  it("recognizes week-over-week phrasings", () => {
    expect(financeMomIntent("这周比上周花得多还是少")).toBe("week");
    expect(financeMomIntent("本周支出和上周比怎么样")).toBe("week");
  });
  it("does not hijack single-period questions", () => {
    expect(financeMomIntent("上个月结余多少钱")).toBeNull();
    expect(financeMomIntent("上个月一共花了多少钱")).toBeNull();
    expect(financeMomIntent("这个月花了多少钱")).toBeNull();
    expect(financeMomIntent("买机械键盘花了多少钱")).toBeNull();
  });
});

// ---- P1: 比较答案由 financeStats 确定性生成 ----

function note(over: Partial<NoteRow>): NoteRow {
  return {
    id: over.id ?? "n1",
    user_id: "u1",
    content: "",
    category: "expense",
    tags: "[]",
    title: null,
    amount: null,
    currency: null,
    created_at: "2026-08-10 00:00:00",
    ...over,
  } as NoteRow;
}

describe("buildFinanceCompareAnswer (R168 P1)", () => {
  it("compares income vs expense per currency with exact difference", () => {
    const stats = financeStats([
      note({ id: "e1", category: "expense", amount: 10618.5, currency: "CNY" }),
      note({ id: "i1", category: "income", amount: 24932.6, currency: "CNY" }),
    ]);
    const ans = buildFinanceCompareAnswer(stats, "本月");
    expect(ans).toContain("赚得多");
    expect(ans).toContain("14314.10");
    expect(ans).toContain("口径与周报/月报一致");
  });
  it("keeps currencies separate (never cross-currency arithmetic)", () => {
    const stats = financeStats([
      note({ id: "e1", category: "expense", amount: 100, currency: "CNY" }),
      note({ id: "e2", category: "expense", amount: 12.99, currency: "USD" }),
      note({ id: "i1", category: "income", amount: 50, currency: "CNY" }),
    ]);
    const ans = buildFinanceCompareAnswer(stats, null);
    expect(ans).toContain("不同币种金额不可直接比较");
    expect(ans).toContain("CNY");
    expect(ans).toContain("USD");
  });
  it("answers 花得多 when expenses exceed income", () => {
    const stats = financeStats([
      note({ id: "e1", category: "expense", amount: 300, currency: "CNY" }),
      note({ id: "i1", category: "income", amount: 100, currency: "CNY" }),
    ]);
    expect(buildFinanceCompareAnswer(stats, "本月")).toContain("花得多");
  });
  it("says no records instead of hallucinating", () => {
    const empty: FinanceStats = { expenseCount: 0, incomeCount: 0, transferCount: 0, totals: {}, unknownAmount: 0 };
    expect(buildFinanceCompareAnswer(empty, "本月")).toContain("没有记账记录");
  });
  it("discloses unknown-amount rows excluded from comparison", () => {
    const stats = financeStats([
      note({ id: "e1", category: "expense", amount: 100, currency: "CNY" }),
      note({ id: "e2", category: "expense", amount: null }),
      note({ id: "i1", category: "income", amount: 500, currency: "CNY" }),
    ]);
    expect(buildFinanceCompareAnswer(stats, null)).toContain("未识别出金额");
  });
});

describe("buildFinanceMomAnswer (R168 P1)", () => {
  it("compares both periods per currency deterministically", () => {
    const cur = financeStats([note({ id: "e1", category: "expense", amount: 500, currency: "CNY" })]);
    const prev = financeStats([note({ id: "e2", category: "expense", amount: 300, currency: "CNY" })]);
    const ans = buildFinanceMomAnswer(cur, prev, "本月", "上个月");
    expect(ans).toContain("多花 ¥200");
    expect(ans).toContain("本月");
    expect(ans).toContain("上个月");
  });
  it("handles empty periods without inventing numbers", () => {
    const empty: FinanceStats = { expenseCount: 0, incomeCount: 0, transferCount: 0, totals: {}, unknownAmount: 0 };
    expect(buildFinanceMomAnswer(empty, empty, "本月", "上个月")).toContain("都没有记账记录");
  });
});

// ---- P2-1: GBK CSV 解码 ----

describe("decodeTextBytes (R168 P2-1)", () => {
  it("decodes valid UTF-8 unchanged", () => {
    expect(decodeTextBytes(strToU8("日期,类别,金额,备注"))).toBe("日期,类别,金额,备注");
  });
  it("strips a UTF-8 BOM", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8("日期,金额")]);
    expect(decodeTextBytes(bom)).toBe("日期,金额");
  });
  it("falls back to GBK when strict UTF-8 decode fails", () => {
    // 「日期,类别」 in GBK: 日=0xC8D5 期=0xC6DA 类=0xC0E0 别=0xB1F0
    const gbk = new Uint8Array([0xc8, 0xd5, 0xc6, 0xda, 0x2c, 0xc0, 0xe0, 0xb1, 0xf0]);
    expect(decodeTextBytes(gbk)).toBe("日期,类别");
  });
  it("extractFileText decodes GBK csv without mojibake", async () => {
    const gbk = new Uint8Array([0xc8, 0xd5, 0xc6, 0xda, 0x2c, 0xbd, 0xf0, 0xb6, 0xee]); // 日期,金额
    const text = await extractFileText("csv", gbk);
    expect(text).toBe("日期,金额");
    expect(text).not.toContain("\ufffd");
  });
});

// ---- P2-2: 内容嗅探优先于扩展名 ----

function fakeXlsxBytes(): Uint8Array {
  const sheet =
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>';
  const shared = "<sst><si><t>金额</t></si></sst>";
  return zipSync({
    "xl/workbook.xml": strToU8("<workbook/>"),
    "xl/sharedStrings.xml": strToU8(shared),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  });
}

describe("sniffFileKind / detectFileKind (R168 P2-2)", () => {
  it("sniffs xlsx from OOXML zip magic bytes", () => {
    expect(sniffFileKind(fakeXlsxBytes())).toBe("xlsx");
  });
  it("sniffs pdf from %PDF- header", () => {
    expect(sniffFileKind(strToU8("%PDF-1.7 ..."))).toBe("pdf");
  });
  it("content wins over a disguised .csv extension", () => {
    expect(detectFileKind("台账.csv", "text/csv", fakeXlsxBytes())).toBe("xlsx");
  });
  it("docx zip is distinguished from xlsx", () => {
    const docx = zipSync({ "word/document.xml": strToU8("<w:document/>") });
    expect(detectFileKind("report.csv", "text/csv", docx)).toBe("docx");
  });
  it("plain text keeps extension-based detection", () => {
    expect(detectFileKind("表格.csv", "text/csv", strToU8("a,b,c\n1,2,3"))).toBe("csv");
    expect(detectFileKind("notes.txt", "", strToU8("hello"))).toBe("txt");
  });
  it("unknown zip is not claimed by the sniffer", () => {
    const zip = zipSync({ "random.bin": strToU8("xx") });
    expect(sniffFileKind(zip)).toBeNull();
  });
});

// ---- P2-4 + P2-5: 标签重命名覆盖回收站 + 端点限流 ----

interface FakeNote {
  id: string;
  user_id: string;
  tags: string;
  is_sensitive: number;
  deleted_at: string | null;
  url?: string | null;
}

function fakeDb(notes: FakeNote[], tokenHash: string, userId: string) {
  const rateLimits = new Map<string, { window_start: string; count: number }>();
  const db = {
    notes,
    async batch(stmts: { run(): Promise<unknown> }[]) {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first() {
          if (sql.startsWith("INSERT INTO auth_rate_limits")) {
            const key = binds[0] as string;
            const windowStart = binds[1] as string;
            const row = rateLimits.get(key);
            const count = row && row.window_start === windowStart ? row.count + 1 : 1;
            rateLimits.set(key, { window_start: windowStart, count });
            return { count };
          }
          if (sql.includes("FROM api_tokens WHERE token_hash = ?")) {
            return binds[0] === tokenHash ? { user_id: userId } : null;
          }
          if (sql.includes("SELECT id, url FROM notes WHERE id = ? AND user_id = ?")) {
            const n = notes.find((x) => x.id === binds[0] && x.user_id === binds[1]);
            return n ? { id: n.id, url: n.url ?? null } : null;
          }
          if (sql.includes("FROM notes WHERE id = ? AND user_id = ? AND deleted_at IS NULL")) {
            return null; // retry-media: 404 once past the limiter
          }
          return null;
        },
        async all() {
          if (sql.includes("SELECT id, tags, is_sensitive FROM notes WHERE user_id = ? AND tags LIKE ?")) {
            const like = (binds[1] as string).replaceAll("%", "");
            return {
              results: notes
                .filter((n) => n.user_id === binds[0] && n.tags.includes(like))
                .map((n) => ({ id: n.id, tags: n.tags, is_sensitive: n.is_sensitive })),
            };
          }
          return { results: [] };
        },
        async run() {
          if (sql.startsWith("UPDATE notes SET tags = ?")) {
            const n = notes.find((x) => x.id === binds[1] && x.user_id === binds[2]);
            if (n) n.tags = binds[0] as string;
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db;
}

const TOKEN = "tok-r168-test";

async function makeEnv(notes: FakeNote[]) {
  const hash = await sha256Hex(TOKEN);
  return { DB: fakeDb(notes, hash, "u1"), AI_MODEL: "mock" } as unknown as Record<string, unknown>;
}

function post(path: string, body?: unknown) {
  return new Request(`http://x${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

describe("tags rename covers trash notes (R168 P2-4)", () => {
  it("renames the tag on soft-deleted notes too", async () => {
    const notes: FakeNote[] = [
      { id: "n1", user_id: "u1", tags: '["咖啡"]', is_sensitive: 0, deleted_at: null },
      { id: "n2", user_id: "u1", tags: '["咖啡"]', is_sensitive: 0, deleted_at: "2026-08-01 00:00:00" },
    ];
    const env = await makeEnv(notes);
    const res = await app.request(post("/api/tags/rename", { from: "咖啡", to: "咖啡馆" }), undefined, env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { affected: number };
    expect(body.affected).toBe(2);
    expect(notes[0].tags).toBe('["咖啡馆"]');
    expect(notes[1].tags).toBe('["咖啡馆"]'); // 回收站行同步，恢复后口径一致
  });
  it("deletes the tag from trash notes too", async () => {
    const notes: FakeNote[] = [
      { id: "n1", user_id: "u1", tags: '["咖啡","早餐"]', is_sensitive: 0, deleted_at: "2026-08-01 00:00:00" },
    ];
    const env = await makeEnv(notes);
    const res = await app.request(post("/api/tags/delete", { tag: "咖啡" }), undefined, env, ctx);
    expect(res.status).toBe(200);
    expect(notes[0].tags).toBe('["早餐"]');
  });
});

describe("rate limits on previously unlimited endpoints (R168 P2-5)", () => {
  it("tags rename/delete share the batch_write bucket and hit 429", async () => {
    const env = await makeEnv([]);
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const res = await app.request(post("/api/tags/rename", { from: "a咖", to: "b啡" }), undefined, env, ctx);
      last = res.status;
    }
    expect(last).toBe(429);
    // same bucket: delete is now throttled as well
    const res = await app.request(post("/api/tags/delete", { tag: "a咖" }), undefined, env, ctx);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { retryable: boolean };
    expect(body.retryable).toBe(true);
  });
  it("refetch-link hits 429 after the media_retry budget", async () => {
    const env = await makeEnv([]);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.request(post("/api/notes/nx/refetch-link"), undefined, env, ctx);
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true); // limiter first, then not-found
    expect(statuses[10]).toBe(429);
  });
  it("retry-media shares the media_retry bucket", async () => {
    const env = await makeEnv([]);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.request(post("/api/notes/nx/retry-media"), undefined, env, ctx);
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

// ---- 设计建议 2: 「跟X有关」计条问法并入主题计数 ----

describe("topicCountIntent 「跟X有关」 phrasings (R168 design #2)", () => {
  it("extracts the topic from q12-style questions", () => {
    expect(topicCountIntent("我一共记了几条跟健身有关的")).toBe("健身");
    expect(topicCountIntent("跟健身相关的笔记有多少条")).toBe("健身");
    expect(topicCountIntent("关于健身的记录一共有几条")).toBeNull(); // 无「有关/相关」锚不误扩
  });
  it("keeps existing 计次 phrasings working", () => {
    expect(topicCountIntent("记录过几次房租")).toBe("房租");
  });
});
