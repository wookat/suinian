import { describe, expect, it } from "vitest";
import { parseLedgerTable, splitCsvFields, fixLedgerAmount, parseTriageJson } from "../src/triage";
import { decodeTextBytes, extractFileText } from "../src/files";
import { financeExtremeIntent, financeExtremeTopicTerms, financeListIntent } from "../src/ask";
import type { TriageResult } from "../src/types";

// 硬编码字节（与 r168 同一做法，不引入 iconv 依赖）
const GBK_2ROW = new Uint8Array([0xc2, 0xf2, 0xb2, 0xcb, 0x2c, 0x35, 0x35, 0x2e, 0x35, 0x0a, 0xb5, 0xd8, 0xcc, 0xfa, 0x2c, 0x34]); // 买菜,55.5\n地铁,4
const BIG5_2ROW = new Uint8Array([0xb6, 0x52, 0xb5, 0xe6, 0x2c, 0x35, 0x35, 0x2e, 0x35, 0x0a, 0xa6, 0x61, 0xc5, 0x4b, 0x2c, 0x34]); // 買菜,55.5\n地鐵,4
const GBK_1ROW = new Uint8Array([0xcd, 0xed, 0xb2, 0xcd, 0x2c, 0x31, 0x32, 0x30]); // 晚餐,120

const base: TriageResult = {
  category: "expense",
  tags: [],
  title: "",
  is_sensitive: false,
  todo_due: null,
  amount: null,
  currency: null,
  merchant: null,
};

// ---- P1-2 多行 CSV 记账合计（R177 生产实测 356 元漏账 / GBK 多行不入账）----

describe("splitCsvFields", () => {
  it("splits on comma/fullwidth comma/tab/semicolon", () => {
    expect(splitCsvFields("a,b\tc；d，e")).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("honors quoted fields with embedded separators and escaped quotes", () => {
    expect(splitCsvFields('"午饭,牛肉面",38')).toEqual(["午饭,牛肉面", "38"]);
    expect(splitCsvFields('"他说""好"",走",20')).toEqual(['他说"好",走', "20"]);
  });
});

describe("parseLedgerTable", () => {
  it("sums the R177 four-row UTF-8 ledger to 356", () => {
    const csv = "日期,项目,金额\n8-1,键盘,199\n8-2,鼠标,99\n8-3,午饭,38\n8-4,打车,20";
    expect(parseLedgerTable(csv)).toEqual({ amount: 356, rows: 4 });
  });
  it("sums a headerless two-row ledger (GBK case) to 59.5", () => {
    expect(parseLedgerTable("买菜,55.5\n地铁,4")).toEqual({ amount: 59.5, rows: 2 });
  });
  it("accepts ¥/元 adornments on the money column", () => {
    expect(parseLedgerTable("买菜,¥55.5\n地铁,4元")).toEqual({ amount: 59.5, rows: 2 });
  });
  it("handles quoted fields with escaped quotes in the item column", () => {
    const csv = '"键盘,茶轴",199\n"鼠标 ""G304""",99';
    expect(parseLedgerTable(csv)).toEqual({ amount: 298, rows: 2 });
  });
  it("returns null for prose (not a table)", () => {
    expect(parseLedgerTable("今天买了咖啡 38 元\n很好喝")).toBeNull();
  });
  it("returns null for a single data row (model handles single items)", () => {
    expect(parseLedgerTable("日期,项目,金额\n8-1,键盘,199")).toBeNull();
  });
  it("returns null when the money column is ambiguous (two all-numeric columns)", () => {
    expect(parseLedgerTable("1,199\n2,99")).toBeNull();
  });
  it("returns null on ragged rows", () => {
    expect(parseLedgerTable("买菜,55.5\n地铁,4,备注")).toBeNull();
  });
  it("ignores date-like columns that are not pure numbers", () => {
    expect(parseLedgerTable("2026-08-01,买菜,55.5\n2026-08-02,地铁,4")).toEqual({ amount: 59.5, rows: 2 });
  });
});

describe("fixLedgerAmount", () => {
  it("fills a null amount from the ledger sum (R177 356 元漏账)", () => {
    const csv = "日期,项目,金额\n8-1,键盘,199\n8-2,鼠标,99\n8-3,午饭,38\n8-4,打车,20";
    const fixed = fixLedgerAmount(csv, { ...base, amount: null, currency: null });
    expect(fixed.amount).toBe(356);
    expect(fixed.currency).toBe("CNY");
  });
  it("overrides a wrong model sum with the parsed sum", () => {
    const csv = "买菜,55.5\n地铁,4";
    const fixed = fixLedgerAmount(csv, { ...base, amount: 55.5, currency: "CNY" });
    expect(fixed.amount).toBe(59.5);
  });
  it("keeps a correct model sum untouched", () => {
    const csv = "买菜,55.5\n地铁,4";
    const t = { ...base, amount: 59.5, currency: "CNY" };
    expect(fixLedgerAmount(csv, t)).toBe(t);
  });
  it("never touches non-finance categories (model stays primary judge)", () => {
    const csv = "买菜,55.5\n地铁,4";
    const t = { ...base, category: "data" as const };
    expect(fixLedgerAmount(csv, t)).toBe(t);
  });
  it("leaves prose finance notes to the model", () => {
    const t = { ...base, amount: 38, currency: "CNY" };
    expect(fixLedgerAmount("午饭黄焖鸡 38 块", t)).toBe(t);
  });
});

describe("csv 全家族：编码 × 行数 × 引号（decode → ledger sum）", () => {
  const csvMulti = "日期,项目,金额\n8-1,键盘,199\n8-2,鼠标,99\n8-3,午饭,38\n8-4,打车,20";
  const csvGbk = "买菜,55.5\n地铁,4";

  it("UTF-8 multi-row → 356", async () => {
    const text = await extractFileText("csv", new TextEncoder().encode(csvMulti));
    expect(parseLedgerTable(text!)).toEqual({ amount: 356, rows: 4 });
  });
  it("GBK multi-row → 59.5", async () => {
    const text = await extractFileText("csv", GBK_2ROW);
    expect(text).toContain("买菜");
    expect(parseLedgerTable(text!)).toEqual({ amount: 59.5, rows: 2 });
  });
  it("Big5 multi-row → 59.5", async () => {
    const text = await extractFileText("csv", BIG5_2ROW);
    expect(text).toContain("買菜");
    expect(parseLedgerTable(text!)).toEqual({ amount: 59.5, rows: 2 });
  });
  it("GBK single-row decodes cleanly (single item stays with the model)", () => {
    const text = decodeTextBytes(GBK_1ROW);
    expect(text).toBe("晚餐,120");
    expect(parseLedgerTable(text)).toBeNull();
  });
  it("quoted/escaped multi-row UTF-8 → summed", async () => {
    const csv = '"午饭,牛肉面",38\n"打车 ""滴滴""",20';
    const text = await extractFileText("csv", new TextEncoder().encode(csv));
    expect(parseLedgerTable(text!)).toEqual({ amount: 58, rows: 2 });
  });
});

// R170 的多对象求和路径继续生效（模型真输出多对象时仍求和）
describe("parseTriageJson multi-object path still sums", () => {
  it("sums uniform finance objects", () => {
    const raw =
      '{"category":"expense","amount":199,"tags":[],"title":"键盘"} {"category":"expense","amount":99,"tags":[],"title":"鼠标"}';
    expect(parseTriageJson(raw)?.amount).toBe(298);
  });
});

// ---- P1-3 财务极值路由收口（R177 生产实测 599 vs 458）----

describe("financeExtremeIntent price-inherent wording", () => {
  it("routes 「键盘里最便宜的是哪一把」 without any finance word (R177 3/3 复现)", () => {
    expect(financeExtremeIntent("键盘里最便宜的是哪一把")).toEqual({ kind: "min", direction: "expense", rank: 1 });
    expect(financeExtremeTopicTerms("键盘里最便宜的是哪一把")).toEqual(["键盘"]);
  });
  it("covers 最贵 symmetrically", () => {
    expect(financeExtremeIntent("键盘里最贵的是哪一把")).toEqual({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeTopicTerms("键盘里最贵的是哪一把")).toEqual(["键盘"]);
  });
  it("bare 最贵/最便宜 without topic still routes (global extreme)", () => {
    expect(financeExtremeIntent("最贵的是哪一个")).toEqual({ kind: "max", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("最便宜的是哪一把")).toEqual({ kind: "min", direction: "expense", rank: 1 });
  });
  it("ambiguous 最高/最低 without finance words stays out", () => {
    expect(financeExtremeIntent("最高的山是哪座")).toBeNull();
    expect(financeExtremeIntent("温度最低的城市")).toBeNull();
  });
  it("existing finance-word paths unchanged", () => {
    expect(financeExtremeIntent("我买过的键盘里最便宜的是哪一把")).toEqual({ kind: "min", direction: "expense", rank: 1 });
    expect(financeExtremeIntent("金额最高的收入")).toEqual({ kind: "max", direction: "income", rank: 1 });
  });
});

// ---- P2-2 「记了哪些收入」误路由为全笔记枚举（R177 faith f27）----

describe("financeListIntent income enumeration", () => {
  it("routes 记了哪些收入 to income enumeration", () => {
    expect(financeListIntent("记了哪些收入")).toBe("income");
    expect(financeListIntent("我记了哪些收入")).toBe("income");
  });
  it("keeps topic-qualified enumeration out", () => {
    expect(financeListIntent("买了哪些书")).toBeNull();
  });
});
