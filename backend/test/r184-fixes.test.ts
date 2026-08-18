import { describe, it, expect } from "vitest";
import { parseLedgerTable, fixLedgerAmount } from "../src/triage";
import type { TriageResult } from "../src/types";
import { isLedgerAggregateNote, isRefusalAnswer } from "../src/ask";
import { app } from "../src/index";

// ---- P1-1 带标题/落款行的多行台账（audit-r183）----

describe("parseLedgerTable title/footer lines (R183 P1-1)", () => {
  it("skips a leading single-field title line", () => {
    expect(parseLedgerTable("购物清单\n买鼠标,99\n买键盘,199\n打车,58")).toEqual({ amount: 356, rows: 3 });
  });

  it("skips title line plus a header row", () => {
    expect(parseLedgerTable("购物清单\n项目,金额\n买鼠标,99\n买键盘,199")).toEqual({ amount: 298, rows: 2 });
  });

  it("skips a trailing single-field footer line", () => {
    expect(parseLedgerTable("买鼠标,99\n买键盘,199\n以上是本周开销")).toEqual({ amount: 298, rows: 2 });
  });

  it("skips both title and footer lines", () => {
    expect(parseLedgerTable("购物清单\n买鼠标,99\n打车,58\n记得报销")).toEqual({ amount: 157, rows: 2 });
  });

  it("does not skip a single-field money line (stays conservative)", () => {
    expect(parseLedgerTable("356元\n买鼠标,99\n买键盘,199")).toBeNull();
  });

  it("still rejects prose with fewer than 2 table rows after stripping", () => {
    expect(parseLedgerTable("购物清单\n买鼠标,99")).toBeNull();
    expect(parseLedgerTable("今天买了咖啡 38 元\n很好喝")).toBeNull();
  });
});

describe("isLedgerAggregateNote with title-line ledgers (R183 P1-1)", () => {
  const content = "购物清单\n买鼠标,99\n买键盘,199\n打车,58";
  it("recognizes the AI-summed titled ledger as aggregate", () => {
    expect(isLedgerAggregateNote({ content, amount: 356 })).toBe(true);
  });
  it("keeps manually-overridden amounts as single expenses", () => {
    expect(isLedgerAggregateNote({ content, amount: 99 })).toBe(false);
  });
});

describe("fixLedgerAmount with titled ledger (R183 P1-1)", () => {
  it("locks the amount to the column sum", () => {
    const triage = { category: "expense", amount: null } as unknown as TriageResult;
    const fixed = fixLedgerAmount("购物清单\n买鼠标,99\n买键盘,199\n打车,58", triage);
    expect(fixed.amount).toBe(356);
  });
});

// ---- P2-2 双金额列歧义表格「歧义不猜」（audit-r183）----

describe("fixLedgerAmount ambiguous money columns (R183 P2-2)", () => {
  it("nulls a model-guessed sum for a two-money-column table", () => {
    const triage = { category: "expense", amount: 1000 } as unknown as TriageResult;
    expect(fixLedgerAmount("100,200\n300,400", triage).amount).toBeNull();
  });
  it("leaves non-table prose amounts alone", () => {
    const triage = { category: "expense", amount: 38 } as unknown as TriageResult;
    expect(fixLedgerAmount("今天买咖啡花了 38 元", triage).amount).toBe(38);
  });
  it("parseLedgerTable still returns null for ambiguous tables", () => {
    expect(parseLedgerTable("100,200\n300,400")).toBeNull();
  });
});

// ---- P1-3 否认+引用自相矛盾按拒答处理（audit-r183）----

describe("isRefusalAnswer denial-with-citations (R183 P1-3)", () => {
  it("treats a pure single-sentence denial with [n] markers as refusal", () => {
    expect(isRefusalAnswer("笔记里没提到关于洗牙的记录 [1] [2] [3]")).toBe(true);
    expect(isRefusalAnswer("没有找到相关记录 [1]。")).toBe(true);
  });

  it("keeps partial denials with a contrast clause as normal answers", () => {
    expect(isRefusalAnswer("没找到电费，但 [2] 提到房租。")).toBe(false);
  });

  it("keeps multi-sentence answers containing a denial as normal answers", () => {
    expect(isRefusalAnswer("没提到洗牙的费用。你在 [1] 记过周四去补牙。")).toBe(false);
  });

  it("keeps citation-backed affirmative answers untouched", () => {
    expect(isRefusalAnswer("根据 [1]，你决定改游泳。")).toBe(false);
  });

  it("still detects citation-free refusals", () => {
    expect(isRefusalAnswer("没找到。")).toBe(true);
  });
});

// ---- P1-2 /api/import 多部分文本走编码嗅探管道（audit-r183）----

/** 极简 fake D1：auth + 限频 + 去重 SELECT + 捕获 INSERT 绑定的 content。 */
function fakeImportDb() {
  const insertedContents: string[] = [];
  const db = {
    insertedContents,
    async batch() {
      return [];
    },
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          if (sql.includes("INSERT INTO notes")) {
            for (const b of args) if (typeof b === "string" && b.length > 1 && !b.startsWith("{")) insertedContents.push(b);
          }
          return stmt;
        },
        async first() {
          if (sql.includes("FROM users WHERE api_token = ?")) return binds[0] === "tok" ? { id: "u_test" } : null;
          if (sql.includes("rate_limits")) return { count: 1 };
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db as typeof db & D1Database;
}

function importForm(source: string, bytes: Uint8Array, name: string): Request {
  const form = new FormData();
  form.set("source", source);
  form.set("file", new File([bytes.slice().buffer], name));
  return new Request("http://local/api/import", {
    method: "POST",
    headers: { authorization: "Bearer tok" },
    body: form,
  });
}

const testCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

describe("POST /api/import multipart encoding sniffing (R183 P1-2)", () => {
  it("decodes a GBK csv upload without mojibake", async () => {
    const DB = fakeImportDb();
    // 「日期,金额」的 GBK 编码 + 一行数据
    const gbk = new Uint8Array([0xc8, 0xd5, 0xc6, 0xda, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0x31, 0x2d, 0x31, 0x2c, 0x39, 0x39]);
    const res = await app.request(importForm("text", gbk, "账本.csv"), undefined, { DB }, testCtx);
    expect(res.status).toBe(201);
    const joined = DB.insertedContents.join("\n");
    expect(joined).toContain("日期,金额");
    expect(joined).not.toContain("\ufffd");
  });

  it("decodes a Big5 txt upload without mojibake", async () => {
    const DB = fakeImportDb();
    // 「統一發票報帳，計程車資三百五十元」的 Big5 编码
    const big5 = new Uint8Array([
      178, 206, 164, 64, 181, 111, 178, 188, 179, 248, 177, 98, 161, 65, 173, 112,
      181, 123, 168, 174, 184, 234, 164, 84, 166, 202, 164, 173, 164, 81, 164, 184,
    ]);
    const res = await app.request(importForm("markdown", big5, "備忘.txt"), undefined, { DB }, testCtx);
    expect(res.status).toBe(201);
    const joined = DB.insertedContents.join("\n");
    expect(joined).toContain("統一發票報帳，計程車資三百五十元");
    expect(joined).not.toContain("\ufffd");
  });

  it("rejects binary bytes masquerading as text (R183 P2-1)", async () => {
    const DB = fakeImportDb();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const res = await app.request(importForm("text", png, "photo.csv"), undefined, { DB }, testCtx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("不是文本内容");
    expect(DB.insertedContents.length).toBe(0);
  });

  it("still accepts plain UTF-8 uploads", async () => {
    const DB = fakeImportDb();
    const res = await app.request(importForm("text", new TextEncoder().encode("第一条笔记\n\n第二条笔记"), "notes.txt"), undefined, { DB }, testCtx);
    expect(res.status).toBe(201);
    expect(DB.insertedContents.join("\n")).toContain("第一条笔记");
  });
});
